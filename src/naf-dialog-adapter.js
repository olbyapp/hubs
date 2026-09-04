import * as mediasoupClient from "mediasoup-client";
import protooClient from "protoo-client";
import { debug as newDebug } from "debug";
import EventEmitter from "eventemitter3";
import { MediaDevices } from "./utils/media-devices-utils";
import { recordRtcEvent } from "./utils/rtc-telemetry";

// Used for VP9 webcam video.
//const VIDEO_KSVC_ENCODINGS = [{ scalabilityMode: "S3T3_KEY" }];

// Used for VP9 desktop sharing.
//const VIDEO_SVC_ENCODINGS = [{ scalabilityMode: "S3T3", dtx: true }];

// TODO
// - look into requestConsumerKeyframe
// - look into applyNetworkThrottle
// SFU todo
// - remove active speaker stuff
// - remove score stuff

// Based upon mediasoup-demo RoomClient

const debug = newDebug("naf-dialog-adapter:debug");
//const warn = newDebug("naf-dialog-adapter:warn");
const error = newDebug("naf-dialog-adapter:error");
const info = newDebug("naf-dialog-adapter:info");

const PC_PROPRIETARY_CONSTRAINTS = {
  optional: [{ googDscp: true }]
};

const WEBCAM_SIMULCAST_ENCODINGS = [
  { scaleResolutionDownBy: 4, maxBitrate: 500000 },
  { scaleResolutionDownBy: 2, maxBitrate: 1000000 },
  { scaleResolutionDownBy: 1, maxBitrate: 5000000 }
];

// Used for simulcast screen sharing.
// Raised from 1.5/6 Mbps: native-resolution text needs headroom. Dialog's
// per-transport maxIncomingBitrate is raised to match (see dialog-config ConfigMap).
const SCREEN_SHARING_SIMULCAST_ENCODINGS = [
  { dtx: true, maxBitrate: 2000000 },
  { dtx: true, maxBitrate: 8000000 }
];

// vegamix: Chrome and Firefox signal simulcast with RIDs, which the SFU can follow.
// Safari has no RID path in mediasoup-client, so its handler rewrites the SDP offer
// instead, inventing one SSRC per layer by counting up from the real one
// (addLegacySimulcast in handlers/sdp/unifiedPlanUtils). Current WebKit ignores that
// rewrite and transmits under SSRCs of its own choosing, so the SFU ends up holding
// bookkeeping for layers that never arrive - "RTP inactivity detected, resetting score
// to 0" - while dropping the packets that do - "no suitable Producer for received RTP
// packet". Nobody can consume a layer that does not exist, so remote viewers get a
// black rectangle. Every browser on iOS is WebKit, so this covers all of them.
//
// One encoding means no rewrite: the SSRC in the offer is the one Safari actually
// sends. The cost is a phone camera without layers to switch between, which matters
// far less than it not arriving at all.
function encodingsFor(mediasoupDevice, encodings) {
  const rewritesSdpForSimulcast = /^Safari/.test((mediasoupDevice && mediasoupDevice.handlerName) || "");
  return rewritesSdpForSimulcast ? encodings.slice(-1) : encodings;
}

// vegamix: how patiently the signalling socket is re-dialed before the person is
// shown the exit screen. Upstream reconnects only by moving to another server,
// which a single-host deployment does not have - see _retryConnectWithNewHost.
const RECONNECT_DELAYS_MS = [2000, 4000, 8000, 15000, 30000];

// vegamix: the transport watchdog. How often both transports are looked at, how
// long "disconnected" may last before it is treated as dead rather than as a
// blip (browsers may sit in it forever without ever reaching "failed", and only
// "failed" has an event handler), and how many silent samples convict a mic.
const TRANSPORT_WATCHDOG_MS = 10000;
const STUCK_DISCONNECTED_MS = 15000;
const DEAD_MIC_SAMPLES = 2;

// vegamix: how many ticks running an unmuted person's audio consumer may bring
// no bytes before it is called dead. Three (thirty seconds) rather than the
// mic's two, because the repair is a receive-transport rebuild that interrupts
// everyone this person hears - a false positive is expensive. Opus DTX thins
// silence out but keeps sending comfort noise every few hundred milliseconds,
// so a genuinely quiet speaker still moves the counter.
const SILENT_CONSUMER_SAMPLES = 3;

// vegamix: rebuilding the receive transport re-announces every producer, which
// is the only safe re-sync the server offers - refreshConsumers on a live
// transport duplicates every consumer, the server keeps no per-peer dedup. A
// rebuild interrupts everything this person hears for a moment, so it is
// debounced and paced.
const RECV_RESYNC_DEBOUNCE_MS = 3000;
const RECV_RESYNC_MIN_INTERVAL_MS = 60000;
const CONSUMER_MISSING_TICKS = 2;

export const DIALOG_CONNECTION_CONNECTED = "dialog-connection-connected";
export const DIALOG_CONNECTION_ERROR_FATAL = "dialog-connection-error-fatal";

export class DialogAdapter extends EventEmitter {
  constructor() {
    super();

    this._micShouldBeEnabled = false;
    this._micProducer = null;
    this._cameraProducer = null;
    this._shareProducer = null;
    this._localMediaStream = null;
    this._publishing = null;
    this._consumers = new Map();
    this._pendingMediaRequests = new Map();
    this._blockedClients = new Map();
    this._forceTcp = false;
    this._forceTurn = false;
    this._iceTransportPolicy = null;
    this.scene = null;
    this._serverParams = {};
    this._consumerStats = {};

    // vegamix: reconnect and watchdog state. _disposed marks a deliberate leave,
    // so a retry that wakes from its backoff knows not to re-dial a room the
    // person already left.
    this._reconnectAttempt = 0;
    this._disposed = false;
    this._sendRecreateInProgress = false;
    this._recvRecreateInProgress = false;
    this._recvResyncTimer = null;
    this._lastRecvResyncAt = 0;
    this._watchdogTimer = null;
    this._badStateSince = { send: null, recv: null };
    this._micBytesSent = null;
    this._micDeadSamples = 0;
    // consumerId -> { bytes, dead }: the byte counter last seen on an audio
    // consumer, and how many ticks running it has not moved.
    this._consumerBytes = new Map();
    // consumerIds whose remote producer is muted. Kept from the newConsumer
    // handshake and the consumerPaused/Resumed notifications.
    this._producerPaused = new Set();
    // peerId -> rebuilds already spent on their audio going silent. Separate
    // from _peerAudioWatch on purpose; see _checkSilentConsumers.
    this._silentPeerRebuilds = new Map();
    // peerId -> { misses, rebuilds }: how long somebody present has had no audio
    // reaching us, and how often that was already answered with a rebuild.
    this._peerAudioWatch = new Map();
    // Peers whose audio has actually arrived at some point. Someone who never
    // published a microphone is quiet by choice, not by fault - telling the two
    // apart is what keeps the watchdog from rebuilding transports for nothing.
    this._everHadAudio = new Set();
  }

  get consumerStats() {
    return this._consumerStats;
  }

  get downlinkBwe() {
    return this._downlinkBwe;
  }

  getIceServers(host, port, turn) {
    const iceServers = [];

    this._serverUrl = `wss://${host}:${port}`;

    if (turn && turn.enabled) {
      turn.transports.forEach(ts => {
        // Try both TURN DTLS and TCP/TLS
        if (!this._forceTcp) {
          iceServers.push({
            urls: `turns:${host}:${ts.port}`,
            username: turn.username,
            credential: turn.credential
          });
        }

        iceServers.push({
          urls: `turns:${host}:${ts.port}?transport=tcp`,
          username: turn.username,
          credential: turn.credential
        });
      });
      iceServers.push({ urls: "stun:stun1.l.google.com:19302" });
    } else {
      iceServers.push({ urls: "stun:stun1.l.google.com:19302" }, { urls: "stun:stun2.l.google.com:19302" });
    }

    return iceServers;
  }

  /**
   * Gets transport/consumer/producer stats on the server side.
   */
  async getServerStats() {
    if (!this._protoo.connected) {
      // Signaling channel not connected, no reason to get remote RTC stats.
      return;
    }

    const result = {};
    try {
      if (!this._sendTransport?._closed) {
        const sendTransport = (result[this._sendTransport.id] = {});
        sendTransport.name = "Send";
        sendTransport.stats = await this._protoo.request("getTransportStats", {
          transportId: this._sendTransport.id
        });
        result[this._sendTransport.id]["producers"] = {};
        for (const producer of this._sendTransport._producers) {
          const id = producer[0];
          result[this._sendTransport.id]["producers"][id] = await this._protoo.request("getProducerStats", {
            producerId: id
          });
        }
      }
      if (!this._recvTransport?._closed) {
        const recvTransport = (result[this._recvTransport.id] = {});
        recvTransport.name = "Receive";
        recvTransport.stats = await this._protoo.request("getTransportStats", {
          transportId: this._recvTransport.id
        });
        result[this._recvTransport.id]["consumers"] = {};
        for (const consumer of this._recvTransport._consumers) {
          const id = consumer[0];
          result[this._recvTransport.id]["consumers"][id] = await this._protoo.request("getConsumerStats", {
            consumerId: id
          });
        }
      }
      return result;
    } catch (e) {
      this.emitRTCEvent("error", "Adapter", () => `Error getting the server status: ${e}`);
      return { error: `Error getting the server status: ${e}` };
    }
  }

  async iceRestart(transport) {
    // Force an ICE restart to gather new candidates and trigger a reconnection
    this.emitRTCEvent(
      "log",
      "RTC",
      () => `Restarting ${transport.id === this._sendTransport.id ? "send" : "receive"} transport ICE`
    );
    const iceParameters = await this._protoo.request("restartIce", { transportId: transport.id });
    // vegamix: this request can outlive its transport. Seen in the wild: both
    // transports failed, the signalling socket dropped with the restartIce
    // requests still in flight, the reconnect rebuilt everything, and only then
    // did the old requests come back (as a timeout, 22 seconds later). Restarting
    // ICE on a transport that has since been replaced would break a working one.
    if (transport.closed || (transport !== this._sendTransport && transport !== this._recvTransport)) {
      this.emitRTCEvent("info", "RTC", () => `Dropping a stale ICE restart for ${transport.id}`);
      return;
    }
    await transport.restartIce({ iceParameters });
  }

  async recreateSendTransport(iceServers) {
    // vegamix: same one-at-a-time rule as the receive side - the ICE-failed
    // handler and the mic-flow watchdog can both get here.
    if (this._sendRecreateInProgress) return;
    this._sendRecreateInProgress = true;
    try {
      await this._recreateSendTransport(iceServers);
    } finally {
      this._sendRecreateInProgress = false;
    }
  }

  async _recreateSendTransport(iceServers) {
    this.emitRTCEvent("log", "RTC", () => `Recreating send transport ICE`);
    await this.closeSendTransport();
    await this.createSendTransport(iceServers);

    // vegamix: closeSendTransport() took the producers down with the old transport,
    // and nothing used to put them back - setLocalMediaStream() is otherwise only
    // reached when the signalling connection reconnects and rejoins the room. The
    // receive side has refreshConsumers for exactly this moment; the send side had no
    // counterpart, so a send transport that failed ICE - which a lossy connection does
    // on its own, and a microphone paused for a while invites - left the person
    // hearing everyone and heard by nobody. Worse, it was unrecoverable from the UI:
    // with no producer, enableMicrophone() logs "no producer" and returns, so the
    // mute button and the device list both stopped doing anything until a reload.
    if (this._localMediaStream) {
      await this.setLocalMediaStream(this._localMediaStream);
    }
  }

  /**
   * Restart ICE in the underlying send peerconnection.
   */
  async restartSendICE() {
    // Do not restart ICE if Signaling is disconnected.
    if (!this._protoo || !this._protoo.connected) {
      return;
    }

    try {
      if (!this._sendTransport?._closed) {
        await this.iceRestart(this._sendTransport);
      } else {
        // If the transport is closed but the signaling is connected, we try to recreate
        const { host, port, turn } = this._serverParams;
        const iceServers = this.getIceServers(host, port, turn);
        await this.recreateSendTransport(iceServers);
      }
    } catch (err) {
      this.emitRTCEvent("error", "RTC", () => `Send transport [recreate] failed: ${err}`);
    }
  }

  /**
   * Checks the Send Transport ICE status and restarts it in case is in failed state.
   * This is called by the Send Transport "connectionstatechange" event listener.
   * @param {boolean} connectionState The transport connnection state (ICE connection state)
   */
  checkSendIceStatus(connectionState) {
    // If the ICE connection state is failed, we force an ICE restart
    if (connectionState === "failed") {
      this.restartSendICE();
    }
  }

  async recreateRecvTransport(iceServers) {
    // vegamix: one at a time - the ICE-failed path, the resync path and the
    // watchdog can all decide to rebuild, and two rebuilds interleaved would
    // close each other's transports.
    if (this._recvRecreateInProgress) return;
    this._recvRecreateInProgress = true;
    try {
      this.emitRTCEvent("log", "RTC", () => `Recreating receive transport ICE`);
      await this.closeRecvTransport();
      // Every consumer is about to be replaced; their byte counters mean
      // nothing against the new ones.
      this._consumerBytes.clear();
      await this.createRecvTransport(iceServers);
      await this._protoo.request("refreshConsumers");
    } finally {
      this._recvRecreateInProgress = false;
    }
  }

  /**
   * Restart ICE in the underlying receive peerconnection.
   * @param {boolean} force Forces the execution of the reconnect.
   */
  async restartRecvICE() {
    if (!this._protoo || !this._protoo.connected) {
      return;
    }

    try {
      if (!this._recvTransport?._closed) {
        await this.iceRestart(this._recvTransport);
      } else {
        // If the transport is closed but the signaling is connected, we try to recreate
        const { host, port, turn } = this._serverParams;
        const iceServers = this.getIceServers(host, port, turn);
        await this.recreateRecvTransport(iceServers);
      }
    } catch (err) {
      this.emitRTCEvent("error", "RTC", () => `Receive transport [recreate] failed: ${err}`);
    }
  }

  /**
   * Checks the ReeceiveReeceive Transport ICE status and restarts it in case is in failed state.
   * This is called by the Reeceive Transport "connectionstatechange" event listener.
   * @param {boolean} connectionState The transport connection state (ICE connection state)
   */
  checkRecvIceStatus(connectionState) {
    // If the ICE connection state is failed, we force an ICE restart
    if (connectionState === "failed") {
      this.restartRecvICE();
    }
  }

  async connect({ serverUrl, roomId, serverParams, scene, clientId, forceTcp, forceTurn, iceTransportPolicy }) {
    this._disposed = false;
    this._startWatchdog();
    this._serverUrl = serverUrl;
    this._roomId = roomId;
    this._serverParams = serverParams;
    this._clientId = clientId;
    this.scene = scene;
    this._forceTcp = forceTcp;
    this._forceTurn = forceTurn;
    this._iceTransportPolicy = iceTransportPolicy;

    const urlWithParams = new URL(this._serverUrl);
    urlWithParams.searchParams.append("roomId", this._roomId);
    urlWithParams.searchParams.append("peerId", this._clientId);

    // TODO: Establishing connection could take a very long time.
    //       Inform the user if we are stuck here.
    const protooTransport = new protooClient.WebSocketTransport(urlWithParams.toString(), {
      retry: { retries: 2 }
    });
    this._protoo = new protooClient.Peer(protooTransport);

    this._protoo.on("disconnected", () => {
      this.emitRTCEvent("info", "Signaling", () => `Disconnected`);
      this.cleanUpLocalState();
    });

    this._protoo.on("failed", attempt => {
      this.emitRTCEvent("error", "Signaling", () => `Failed: ${attempt}, retrying...`);
    });

    this._protoo.on("close", async () => {
      // We explicitly disconnect event handlers when closing the socket ourselves,
      // so if we get into here, we were not the ones closing the connection.
      this.emitRTCEvent("error", "Signaling", () => `Closed`);
      this._retryConnectWithNewHost();
    });

    // eslint-disable-next-line no-unused-vars
    this._protoo.on("request", async (request, accept, reject) => {
      this.emitRTCEvent("info", "Signaling", () => `Request [${request.method}]: ${request.data?.id}`);
      debug('proto "request" event [method:%s, data:%o]', request.method, request.data?.id);

      switch (request.method) {
        case "newConsumer": {
          const { peerId, producerId, id, kind, rtpParameters, /*type, */ appData, producerPaused } = request.data;

          try {
            const consumer = await this._recvTransport.consume({
              id,
              producerId,
              kind,
              rtpParameters,
              appData: { ...appData, peerId } // Trick.
            });

            // Store in the map.
            this._consumers.set(consumer.id, consumer);
            // vegamix: whether the person on the other end is muted. A muted
            // producer sends nothing at all (zeroRtpOnPause), so without this
            // the silent-consumer watchdog would convict most of the room -
            // people are muted about eighty per cent of the time.
            if (producerPaused) {
              this._producerPaused.add(consumer.id);
            } else {
              this._producerPaused.delete(consumer.id);
            }
            // vegamix: proof that this peer does have a microphone and that it
            // reaches us. The watchdog only chases audio that was once here and
            // went missing - see _checkMissingConsumers.
            if (kind === "audio") this._everHadAudio.add(peerId);

            consumer.on("transportclose", () => {
              // vegamix: info, not error. Every consumer fires this when the
              // transport goes, so one failure used to print seventeen error
              // lines and drown the log; the transport's own state change is
              // where the actual failure is reported.
              this.emitRTCEvent("info", "RTC", () => `Consumer transport closed`);
              this.removeConsumer(consumer.id);
            });

            if (kind === "video") {
              const { spatialLayers, temporalLayers } = mediasoupClient.parseScalabilityMode(
                consumer.rtpParameters.encodings[0].scalabilityMode
              );

              this._consumerStats[consumer.id] = this._consumerStats[consumer.id] || {};
              this._consumerStats[consumer.id]["spatialLayers"] = spatialLayers;
              this._consumerStats[consumer.id]["temporalLayers"] = temporalLayers;
            }

            // We are ready. Answer the protoo request so the server will
            // resume this Consumer (which was paused for now if video).
            accept();

            this.resolvePendingMediaRequestForTrack(peerId, consumer.track);

            // Notify of an stream update event
            this.emit("stream_updated", peerId, kind);
          } catch (err) {
            this.emitRTCEvent("error", "Adapter", () => `Error: ${err}`);
            error('"newConsumer" request failed:%o', err);

            // vegamix: rejecting is right - the server must not resume a
            // consumer this side failed to build - but it used to be the end of
            // the story: nobody ever announced that producer to us again, and
            // the person behind it stayed silent until a page reload. Rebuild
            // the receive side, which re-announces every producer that exists.
            this._scheduleRecvResync("newConsumer failed");
            throw err;
          }

          break;
        }
      }
    });

    this._protoo.on("notification", notification => {
      debug('proto "notification" event [method:%s, data:%o]', notification.method, notification.data);

      switch (notification.method) {
        case "newPeer": {
          break;
        }

        case "peerClosed": {
          const { peerId } = notification.data;
          this.closePeer(peerId);

          break;
        }

        case "consumerClosed": {
          const { consumerId } = notification.data;
          const consumer = this._consumers.get(consumerId);

          if (!consumer) {
            info(`consumerClosed event received without related consumer: ${consumerId}`);
            break;
          }

          // vegamix: the server closing a consumer is deliberate - the producer
          // behind it went away, which is what stopping a mic share looks like.
          // Forget that this peer ever had audio, or the watchdog would spend
          // the rest of the session trying to win it back.
          this._everHadAudio.delete(consumer.appData.peerId);
          consumer.close();
          this.removeConsumer(consumer.id);

          break;
        }

        case "peerBlocked": {
          const { peerId } = notification.data;
          document.body.dispatchEvent(new CustomEvent("blocked", { detail: { clientId: peerId } }));

          break;
        }

        case "peerUnblocked": {
          const { peerId } = notification.data;
          document.body.dispatchEvent(new CustomEvent("unblocked", { detail: { clientId: peerId } }));

          break;
        }

        case "downlinkBwe": {
          this._downlinkBwe = notification.data;
          break;
        }

        // vegamix: the server has always sent these two (Room.js emits them on
        // the producer's pause/resume) and the client has always ignored them.
        // The silent-consumer watchdog needs them: they are the difference
        // between "this person muted themselves" and "this person's audio
        // stopped reaching me".
        case "consumerPaused": {
          this._producerPaused.add(notification.data.consumerId);
          this._consumerBytes.delete(notification.data.consumerId);
          break;
        }

        case "consumerResumed": {
          this._producerPaused.delete(notification.data.consumerId);
          // Start counting from whatever arrives next, not from the frozen
          // total the mute left behind.
          this._consumerBytes.delete(notification.data.consumerId);
          break;
        }

        case "consumerLayersChanged": {
          const { consumerId, spatialLayer, temporalLayer } = notification.data;

          const consumer = this._consumers.get(consumerId);

          if (!consumer) {
            info(`consumerLayersChanged event received without related consumer: ${consumerId}`);
            break;
          }

          this._consumerStats[consumerId] = this._consumerStats[consumerId] || {};
          this._consumerStats[consumerId]["spatialLayer"] = spatialLayer;
          this._consumerStats[consumerId]["temporalLayer"] = temporalLayer;

          // TODO: If spatialLayer/temporalLayer are null, that's probably because the current downlink
          // it's not enough forany spatial layer bitrate. In that case the server has paused the consumer.
          // At this point we it would be nice to give the user some visual cue that this stream is paused.
          // ie. A grey overlay with some icon or replacing the video stream por a generic person image.
          break;
        }

        case "consumerScore": {
          const { consumerId, score } = notification.data;

          const consumer = this._consumers.get(consumerId);

          if (!consumer) {
            info(`consumerScore event received without related consumer: ${consumerId}`);
            break;
          }

          this._consumerStats[consumerId] = this._consumerStats[consumerId] || {};
          this._consumerStats[consumerId]["score"] = score;
        }
      }
    });

    return new Promise((resolve, reject) => {
      this._protoo.on("open", async () => {
        this.emitRTCEvent("info", "Signaling", () => `Open`);
        // vegamix: a socket that opened proves the host is reachable; the retry
        // ladder starts from the top next time.
        this._reconnectAttempt = 0;

        try {
          await this._joinRoom();
          resolve();
          this.emit(DIALOG_CONNECTION_CONNECTED);
        } catch (err) {
          this.emitRTCEvent("warn", "Adapter", () => `Error during connect: ${error}`);
          reject(err);
          this.emit(DIALOG_CONNECTION_ERROR_FATAL);
        }
      });
    });
  }

  async _retryConnectWithNewHost() {
    this.cleanUpLocalState();
    this._protoo.removeAllListeners();

    // vegamix: written upstream for a fleet, running here on a single host.
    // Upstream's notion of reconnecting is moving to whichever server reticulum
    // now names; when it names the same one - which on one host it always does -
    // this used to declare failure without having re-dialed even once, so any
    // socket drop that outlived protoo's three tries became the exit screen.
    // A blip deserves patience: re-dial the same host on a backoff and only
    // give up once the ladder is spent.
    let serverParams;
    try {
      serverParams = await APP.hubChannel.getHost();
    } catch (err) {
      // The phoenix channel is down too, so the network itself is out. The
      // params in hand are as good as any while it comes back.
      this.emitRTCEvent("warn", "Signaling", () => `getHost failed (${err}), re-dialing the known host`);
      serverParams = this._serverParams;
    }
    const { host, port } = serverParams;
    const newServerUrl = `wss://${host}:${port}`;
    if (this._serverUrl === newServerUrl) {
      const attempt = this._reconnectAttempt;
      if (attempt >= RECONNECT_DELAYS_MS.length) {
        console.error("Reconnect to dialog failed.");
        this.emit(DIALOG_CONNECTION_ERROR_FATAL);
        return;
      }
      this._reconnectAttempt += 1;
      const delay = RECONNECT_DELAYS_MS[attempt];
      this.emitRTCEvent("warn", "Signaling", () => `Re-dialing the same host in ${delay}ms (attempt ${attempt + 1})`);
      await new Promise(resolve => setTimeout(resolve, delay));
      // The person may have left the room while this slept.
      if (this._disposed) return;
    } else {
      this._reconnectAttempt = 0;
      console.log(`The Dialog server has changed to ${newServerUrl}, reconnecting with the new server...`);
    }
    await this.connect({
      serverUrl: newServerUrl,
      roomId: this._roomId,
      serverParams,
      scene: this.scene,
      clientId: this._clientId,
      forceTcp: this._forceTcp,
      forceTurn: this._forceTurn,
      iceTransportPolicy: this._iceTransportPolicy
    });
  }

  closePeer(peerId) {
    const pendingMediaRequests = this._pendingMediaRequests.get(peerId);

    if (pendingMediaRequests) {
      const msg = "The user disconnected before the media stream was resolved.";
      info(msg);

      if (pendingMediaRequests.audio) {
        pendingMediaRequests.audio.resolve(null);
      }

      if (pendingMediaRequests.video) {
        pendingMediaRequests.video.resolve(null);
      }

      this._pendingMediaRequests.delete(peerId);
    }
  }

  resolvePendingMediaRequestForTrack(clientId, track) {
    const requests = this._pendingMediaRequests.get(clientId);

    if (requests && requests[track.kind]) {
      const resolve = requests[track.kind].resolve;
      delete requests[track.kind];
      resolve(new MediaStream([track]));
    }

    if (requests && Object.keys(requests).length === 0) {
      this._pendingMediaRequests.delete(clientId);
    }
  }

  removeConsumer(consumerId) {
    this.emitRTCEvent("info", "RTC", () => `Consumer removed: ${consumerId}`);
    this._consumers.delete(consumerId);
    this._producerPaused.delete(consumerId);
    this._consumerBytes.delete(consumerId);
  }

  getMediaStream(clientId, kind = "audio") {
    let track;

    if (this._clientId === clientId) {
      if (kind === "audio" && this._micProducer) {
        track = this._micProducer.track;
      } else if (kind === "video") {
        if (this._cameraProducer && !this._cameraProducer.closed) {
          track = this._cameraProducer.track;
        } else if (this._shareProducer && !this._shareProducer.closed) {
          track = this._shareProducer.track;
        }
      }
    } else {
      this._consumers.forEach(consumer => {
        if (consumer.appData.peerId === clientId && kind == consumer.track.kind) {
          track = consumer.track;
        }
      });
    }

    if (track) {
      debug(`Already had ${kind} for ${clientId}`);
      return Promise.resolve(new MediaStream([track]));
    } else {
      debug(`Waiting on ${kind} for ${clientId}`);
      if (!this._pendingMediaRequests.has(clientId)) {
        this._pendingMediaRequests.set(clientId, {});
      }

      const requests = this._pendingMediaRequests.get(clientId);
      const promise = new Promise((resolve, reject) => (requests[kind] = { resolve, reject }));
      requests[kind].promise = promise;
      promise.catch(e => {
        this.emitRTCEvent("error", "Adapter", () => `getMediaStream error: ${e}`);
        console.warn(`${clientId} getMediaStream Error`, e);
      });
      return promise;
    }
  }

  async createSendTransport(iceServers) {
    // Create mediasoup Transport for sending (unless we don't want to produce).
    const sendTransportInfo = await this._protoo.request("createWebRtcTransport", {
      producing: true,
      consuming: false,
      sctpCapabilities: undefined
    });

    this._sendTransport = this._mediasoupDevice.createSendTransport({
      id: sendTransportInfo.id,
      iceParameters: sendTransportInfo.iceParameters,
      iceCandidates: sendTransportInfo.iceCandidates,
      dtlsParameters: sendTransportInfo.dtlsParameters,
      sctpParameters: sendTransportInfo.sctpParameters,
      iceServers,
      iceTransportPolicy: this._iceTransportPolicy,
      proprietaryConstraints: PC_PROPRIETARY_CONSTRAINTS
    });

    this._sendTransport.on("connect", ({ dtlsParameters }, callback, errback) => {
      this.emitRTCEvent("info", "RTC", () => `Send transport [connect]`);
      this._sendTransport.observer.on("close", () => {
        this.emitRTCEvent("info", "RTC", () => `Send transport [close]`);
      });
      this._sendTransport.observer.on("newproducer", producer => {
        this.emitRTCEvent("info", "RTC", () => `Send transport [newproducer]: ${producer.id}`);
      });
      this._sendTransport.observer.on("newconsumer", consumer => {
        this.emitRTCEvent("info", "RTC", () => `Send transport [newconsumer]: ${consumer.id}`);
      });

      this._protoo
        .request("connectWebRtcTransport", {
          transportId: this._sendTransport.id,
          dtlsParameters
        })
        .then(callback)
        .catch(errback);
    });

    this._sendTransport.on("connectionstatechange", connectionState => {
      let level = "info";
      if (connectionState === "failed" || connectionState === "disconnected") {
        level = "error";
      }
      this.emitRTCEvent(level, "RTC", () => `Send transport [connectionstatechange]: ${connectionState}`);

      this.checkSendIceStatus(connectionState);
    });

    this._sendTransport.on("produce", async ({ kind, rtpParameters, appData }, callback, errback) => {
      this.emitRTCEvent("info", "RTC", () => `Send transport [produce]: ${kind}`);
      try {
        const { id } = await this._protoo.request("produce", {
          transportId: this._sendTransport.id,
          kind,
          rtpParameters,
          appData
        });

        callback({ id });
      } catch (error) {
        this.emitRTCEvent("error", "Signaling", () => `[produce] error: ${error}`);
        errback(error);
      }
    });
  }

  async closeSendTransport() {
    if (this._micProducer) {
      this._micProducer.close();
      this._protoo?.connected && this._protoo?.request("closeProducer", { producerId: this._micProducer.id });
      this._micProducer = null;
    }

    if (this._videoProducer) {
      this._videoProducer.close();
      this._protoo?.connected && this._protoo?.request("closeProducer", { producerId: this._videoProducer.id });
      this._videoProducer = null;
    }

    // TODO: If _sendTransport is falsey then return
    const transportId = this._sendTransport?.id;
    if (this._sendTransport && !this._sendTransport._closed) {
      this._sendTransport.close();
      this._sendTransport = null;
    }

    if (this._protoo?.connected) {
      try {
        await this._protoo.request("closeWebRtcTransport", { transportId });
      } catch (err) {
        error(err);
      }
    }
  }

  async createRecvTransport(iceServers) {
    // Create mediasoup Transport for sending (unless we don't want to consume).
    const recvTransportInfo = await this._protoo.request("createWebRtcTransport", {
      producing: false,
      consuming: true,
      sctpCapabilities: undefined
    });

    this._recvTransport = this._mediasoupDevice.createRecvTransport({
      id: recvTransportInfo.id,
      iceParameters: recvTransportInfo.iceParameters,
      iceCandidates: recvTransportInfo.iceCandidates,
      dtlsParameters: recvTransportInfo.dtlsParameters,
      sctpParameters: recvTransportInfo.sctpParameters,
      iceServers,
      iceTransportPolicy: this._iceTransportPolicy
    });

    this._recvTransport.on("connect", ({ dtlsParameters }, callback, errback) => {
      this.emitRTCEvent("info", "RTC", () => `Receive transport [connect]`);
      this._recvTransport.observer.on("close", () => {
        this.emitRTCEvent("info", "RTC", () => `Receive transport [close]`);
      });
      this._recvTransport.observer.on("newproducer", producer => {
        this.emitRTCEvent("info", "RTC", () => `Receive transport [newproducer]: ${producer.id}`);
      });
      this._recvTransport.observer.on("newconsumer", consumer => {
        this.emitRTCEvent("info", "RTC", () => `Receive transport [newconsumer]: ${consumer.id}`);
      });

      this._protoo
        .request("connectWebRtcTransport", {
          transportId: this._recvTransport.id,
          dtlsParameters
        })
        .then(callback)
        .catch(errback);
    });

    this._recvTransport.on("connectionstatechange", connectionState => {
      let level = "info";
      if (connectionState === "failed" || connectionState === "disconnected") {
        level = "error";
      }
      this.emitRTCEvent(level, "RTC", () => `Receive transport [connectionstatechange]: ${connectionState}`);

      this.checkRecvIceStatus(connectionState);
    });
  }

  async closeRecvTransport() {
    const transportId = this._recvTransport?.id;
    if (this._recvTransport && !this._recvTransport._closed) {
      this._recvTransport.close();
      this._recvTransport = null;
    }
    if (this._protoo?.connected) {
      try {
        await this._protoo.request("closeWebRtcTransport", { transportId });
      } catch (err) {
        error(err);
      }
    }
  }

  async _joinRoom() {
    debug("_joinRoom()");

    this._mediasoupDevice = new mediasoupClient.Device({});

    const routerRtpCapabilities = await this._protoo.request("getRouterRtpCapabilities");

    await this._mediasoupDevice.load({ routerRtpCapabilities });

    const { host, port, turn } = this._serverParams;
    const iceServers = this.getIceServers(host, port, turn);

    await this.createSendTransport(iceServers);
    await this.createRecvTransport(iceServers);

    await this._protoo.request("join", {
      displayName: this._clientId,
      device: this._device,
      rtpCapabilities: this._mediasoupDevice.rtpCapabilities,
      sctpCapabilities: this._useDataChannel ? this._mediasoupDevice.sctpCapabilities : undefined,
      token: APP.hubChannel.token
    });

    if (this._localMediaStream) {
      // TODO: Refactor to be "Create producers"
      await this.setLocalMediaStream(this._localMediaStream);
    }
  }

  // vegamix: one at a time. There are now several paths that republish - the rejoin,
  // the transport coming back, the mute button finding no producer, a device change -
  // and two of them running at once would both see _micProducer as null and both
  // produce(), leaving a second, orphaned producer sending the same audio.
  async setLocalMediaStream(stream) {
    this._publishing = (this._publishing || Promise.resolve())
      .catch(() => {})
      .then(() => this._setLocalMediaStream(stream));
    return this._publishing;
  }

  async _setLocalMediaStream(stream) {
    if (!this._sendTransport) {
      console.error("Tried to setLocalMediaStream before a _sendTransport existed");
      return;
    }
    this.emitRTCEvent("info", "RTC", () => `Creating missing producers`);
    let sawAudio = false;
    let sawVideo = false;

    await Promise.all(
      stream.getTracks().map(async track => {
        if (track.kind === "audio") {
          sawAudio = true;

          // TODO multiple audio tracks?
          if (this._micProducer) {
            if (this._micProducer.track !== track) {
              this._micProducer.track.stop();
              this._micProducer.replaceTrack(track);
            }
          } else {
            // stopTracks = false because otherwise the track will end during a temporary disconnect
            this._micProducer = await this._sendTransport.produce({
              track,
              pause: !this._micShouldBeEnabled,
              stopTracks: false,
              codecOptions: { opusStereo: false, opusDtx: true },
              zeroRtpOnPause: true,
              disableTrackOnPause: true
            });

            this._micProducer.on("transportclose", () => {
              this.emitRTCEvent("info", "RTC", () => `Mic transport closed`);
              this._micProducer = null;
            });

            this.emit("mic-state-changed", { enabled: this.isMicEnabled });
          }
        } else {
          sawVideo = true;

          if (track._hubs_contentHint === MediaDevices.SCREEN) {
            await this.disableCamera();
            await this.enableShare(track);
          } else if (track._hubs_contentHint === MediaDevices.CAMERA) {
            await this.disableShare();
            await this.enableCamera(track);
          }
        }

        this.resolvePendingMediaRequestForTrack(this._clientId, track);
      })
    );

    if (!sawAudio && this._micProducer) {
      this._protoo.request("closeProducer", { producerId: this._micProducer.id });
      this._micProducer.close();
      this._micProducer = null;
    }
    if (!sawVideo) {
      this.disableCamera();
      this.disableShare();
    }
    this._localMediaStream = stream;
  }

  async enableCamera(track) {
    // stopTracks = false because otherwise the track will end during a temporary disconnect
    this._cameraProducer = await this._sendTransport.produce({
      track,
      stopTracks: false,
      codecOptions: { videoGoogleStartBitrate: 1000 },
      encodings: encodingsFor(this._mediasoupDevice, WEBCAM_SIMULCAST_ENCODINGS),
      zeroRtpOnPause: true,
      disableTrackOnPause: true
    });

    this._cameraProducer.on("transportclose", () => {
      this.emitRTCEvent("info", "RTC", () => `Camera transport closed`);
      this.disableCamera();
    });
    this._cameraProducer.observer.on("trackended", () => {
      this.emitRTCEvent("info", "RTC", () => `Camera track ended`);
      this.disableCamera();
    });
  }

  async disableCamera() {
    if (!this._cameraProducer) return;

    this._cameraProducer.close();

    try {
      if (!this._sendTransport.closed) {
        await this._protoo.request("closeProducer", { producerId: this._cameraProducer.id });
      }
    } catch (error) {
      console.error(`disableCamera(): ${error}`);
    }

    this._cameraProducer = null;
  }

  async enableShare(track) {
    // stopTracks = false because otherwise the track will end during a temporary disconnect
    this._shareProducer = await this._sendTransport.produce({
      track,
      stopTracks: false,
      codecOptions: { videoGoogleStartBitrate: 1000 },
      encodings: encodingsFor(this._mediasoupDevice, SCREEN_SHARING_SIMULCAST_ENCODINGS),
      zeroRtpOnPause: true,
      disableTrackOnPause: true,
      appData: {
        share: true
      }
    });

    this._shareProducer.on("transportclose", () => {
      this.emitRTCEvent("info", "RTC", () => `Desktop Share transport closed`);
      this.disableShare();
    });
    this._shareProducer.observer.on("trackended", () => {
      this.emitRTCEvent("info", "RTC", () => `Desktop Share transport track ended`);
      this.disableShare();
    });
  }

  async disableShare() {
    if (!this._shareProducer) return;

    this._shareProducer.close();

    try {
      if (!this._sendTransport.closed) {
        await this._protoo.request("closeProducer", { producerId: this._shareProducer.id });
      }
    } catch (error) {
      console.error(`disableShare(): ${error}`);
    }

    this._shareProducer = null;
  }

  toggleMicrophone() {
    if (this.isMicEnabled) {
      this.enableMicrophone(false);
    } else {
      this.enableMicrophone(true);
    }
  }

  enableMicrophone(enabled) {
    if (!this._micProducer) {
      console.error("Tried to toggle mic but there's no producer.");
      // vegamix: but remember what was asked for. A producer made later reads this to
      // decide whether to start paused, so an unmute pressed while there was nothing
      // to unmute is honoured once there is one.
      this._micShouldBeEnabled = enabled;
      // And try to be that moment. This branch means the producer was lost while the
      // room stayed up, which used to leave the mute button doing nothing at all until
      // the page was reloaded - the person presses it, sees the icon change, and is
      // still heard by nobody. Publishing again is what the rejoin path does, and it
      // is safe here: it only runs when there is a transport to publish onto.
      if (enabled && this._sendTransport && this._localMediaStream) {
        this.setLocalMediaStream(this._localMediaStream).catch(err => {
          this.emitRTCEvent("error", "RTC", () => `Could not republish the mic: ${err}`);
        });
      }
      return;
    }

    if (enabled && !this.isMicEnabled) {
      this._micProducer.resume();
      this._protoo.request("resumeProducer", { producerId: this._micProducer.id });
    } else if (!enabled && this.isMicEnabled) {
      this._micProducer.pause();
      this._protoo.request("pauseProducer", { producerId: this._micProducer.id });
    }
    this._micShouldBeEnabled = enabled;
    this.emit("mic-state-changed", { enabled: this.isMicEnabled });
  }

  get isMicEnabled() {
    return this._micProducer && !this._micProducer.paused;
  }

  // vegamix: what the person last asked for, as opposed to what is actually happening.
  // The two disagreeing - wants to be heard, is not being sent - is the signature of a
  // producer lost with its transport, which is what the mic watchdog looks for.
  get micShouldBeEnabled() {
    return this._micShouldBeEnabled;
  }

  cleanUpLocalState() {
    this._sendTransport && this._sendTransport.close();
    this._sendTransport = null;
    this._recvTransport && this._recvTransport.close();
    this._recvTransport = null;
    this._micProducer = null;
    this._shareProducer = null;
    this._cameraProducer = null;
  }

  // ---------------------------------------------------------------------------
  // vegamix: the transport watchdog. Three failure shapes reach it, all found in
  // the wild on this deployment and none covered by an event:
  //
  //  - a transport that sits in "disconnected" forever: only "failed" has a
  //    handler, and browsers are not obliged to ever get there;
  //  - a mic producer that is live and unmuted on a "connected" transport yet
  //    moves no bytes - the DTLS-died-one-way shape, "I hear everyone, nobody
  //    hears me";
  //  - a person present in the room with no audio consumer for them - a lost
  //    newConsumer, "everyone hears them except me".
  //
  // Each repair is the same one the respective event handler would have run,
  // just decided by looking instead of waiting to be told.

  _startWatchdog() {
    if (this._watchdogTimer) return;
    this._watchdogTimer = setInterval(() => this._watchdogTick(), TRANSPORT_WATCHDOG_MS);
  }

  _stopWatchdog() {
    if (!this._watchdogTimer) return;
    clearInterval(this._watchdogTimer);
    this._watchdogTimer = null;
  }

  async _watchdogTick() {
    if (this._disposed || !this._protoo || !this._protoo.connected) return;
    try {
      this._checkStuckTransport("send", this._sendTransport, () => this.restartSendICE());
      this._checkStuckTransport("recv", this._recvTransport, () => this.restartRecvICE());
      this._checkMissingConsumers();
      await this._checkMicFlow();
      await this._checkSilentConsumers();
    } catch (err) {
      this.emitRTCEvent("error", "RTC", () => `Watchdog tick failed: ${err}`);
    }
  }

  _checkStuckTransport(name, transport, restart) {
    const state = transport && transport.connectionState;
    if (state === "disconnected") {
      if (!this._badStateSince[name]) {
        this._badStateSince[name] = Date.now();
      } else if (Date.now() - this._badStateSince[name] > STUCK_DISCONNECTED_MS) {
        this._badStateSince[name] = null;
        this.emitRTCEvent("warn", "RTC", () => `${name} transport stuck in disconnected, restarting ICE`);
        restart();
      }
    } else {
      this._badStateSince[name] = null;
    }
  }

  // Zero RTP is legal for a paused producer (zeroRtpOnPause) and for a transport
  // still connecting; only an unmuted microphone on a transport that calls
  // itself connected is obliged to move bytes. Opus DTX thins silence out but
  // never to nothing for twenty seconds. Two flat samples convict.
  async _checkMicFlow() {
    const producer = this._micProducer;
    if (
      !producer ||
      producer.paused ||
      producer.closed ||
      !this._sendTransport ||
      this._sendTransport.connectionState !== "connected"
    ) {
      this._micBytesSent = null;
      this._micDeadSamples = 0;
      return;
    }

    let bytesSent = null;
    try {
      const stats = await producer.getStats();
      stats.forEach(report => {
        if (report.type === "outbound-rtp") bytesSent = report.bytesSent;
      });
    } catch {
      return; // The producer closed mid-await; the next tick sees the truth.
    }
    if (bytesSent === null) return;

    if (this._micBytesSent !== null && bytesSent <= this._micBytesSent) {
      this._micDeadSamples += 1;
      if (this._micDeadSamples >= DEAD_MIC_SAMPLES) {
        this._micDeadSamples = 0;
        this._micBytesSent = null;
        this.emitRTCEvent(
          "warn",
          "RTC",
          () =>
            `Mic producer moved no bytes for ${(DEAD_MIC_SAMPLES * TRANSPORT_WATCHDOG_MS) / 1000}s, rebuilding the send transport`
        );
        try {
          const { host, port, turn } = this._serverParams;
          await this.recreateSendTransport(this.getIceServers(host, port, turn));
        } catch (err) {
          this.emitRTCEvent("error", "RTC", () => `Send rebuild failed: ${err}`);
        }
      }
      return;
    }
    this._micDeadSamples = 0;
    this._micBytesSent = bytesSent;
  }

  // vegamix: "everyone hears them except me" - audio that was reaching us and
  // stopped, while the person is still in the room and the server never said it
  // had closed their producer.
  //
  // The first version of this asked a looser question - present in the room and
  // no audio consumer - and the first day of telemetry showed why that is wrong.
  // Two people were flagged from four independent sessions, all day, including
  // by a listener whose page had just loaded; a fresh join is served every
  // existing producer up front, so there was no lost announcement to recover.
  // They simply had no microphone, and each false positive spent a receive
  // transport rebuild, which costs everyone else a second or two of silence.
  // Never-had-audio is now diagnosed, not repaired: only a peer in
  // _everHadAudio can be missing something.
  _checkMissingConsumers() {
    let state;
    try {
      state = APP.hubChannel.presence.state;
    } catch {
      return;
    }
    if (!state) return;

    const haveAudio = new Set();
    this._consumers.forEach(consumer => {
      if (!consumer.closed && consumer.track && consumer.track.kind === "audio") {
        haveAudio.add(consumer.appData.peerId);
      }
    });

    const lost = [];
    const silent = [];
    for (const id of Object.keys(state)) {
      if (id === this._clientId) continue;
      const meta = state[id].metas && state[id].metas[0];
      if (!meta || meta.presence !== "room") continue;
      if (haveAudio.has(id)) {
        this._peerAudioWatch.delete(id);
        continue;
      }
      if (!this._everHadAudio.has(id)) {
        silent.push(id);
        continue;
      }
      const entry = this._peerAudioWatch.get(id) || { misses: 0, rebuilds: 0 };
      entry.misses += 1;
      this._peerAudioWatch.set(id, entry);
      if (entry.misses >= CONSUMER_MISSING_TICKS && entry.rebuilds < 2) lost.push(id);
    }

    // Forget the departed, or the maps grow for the length of the workday.
    for (const id of this._peerAudioWatch.keys()) {
      if (!state[id]) this._peerAudioWatch.delete(id);
    }
    for (const id of this._everHadAudio) {
      if (!state[id]) this._everHadAudio.delete(id);
    }

    // Not a fault, but the answer to "why is it quiet in here" - and the number
    // the snapshot's audioConsumers/peersInRoom gap is made of.
    if (silent.length) {
      this.emitRTCEvent("info", "RTC", () => `Present with no microphone: ${silent.join(", ")}`);
    }

    if (lost.length === 0) return;
    this.emitRTCEvent("warn", "RTC", () => `Audio was reaching us and stopped: ${lost.join(", ")}`);
    // Only spend a peer's rebuild budget if a rebuild was really scheduled;
    // pacing can drop this on the floor, and a skipped attempt must not count.
    if (this._scheduleRecvResync(`lost audio from ${lost.length} peer(s)`)) {
      for (const id of lost) this._peerAudioWatch.get(id).rebuilds += 1;
    }
  }

  // vegamix: the gap the Iri incident exposed. Every other check here asks
  // whether a consumer *exists*; none asked whether it *delivers*. A consumer
  // left over from a transport blip is a live object that no packets reach, and
  // to a check that counts objects it looks exactly like a working one - so the
  // watchdog stayed silent through eighty minutes of a person hearing less than
  // the room did. Bytes are the only honest answer.
  async _checkSilentConsumers() {
    if (this._recvRecreateInProgress || !this._recvTransport) return;
    // Mid-rebuild or mid-reconnect the counters are meaningless.
    if (this._recvTransport.connectionState !== "connected") {
      this._consumerBytes.clear();
      return;
    }

    const silent = [];
    for (const consumer of this._consumers.values()) {
      if (consumer.closed || consumer.paused) continue;
      if (!consumer.track || consumer.track.kind !== "audio") continue;
      // Muted people are supposed to send nothing.
      if (this._producerPaused.has(consumer.id)) {
        this._consumerBytes.delete(consumer.id);
        continue;
      }

      let bytes = null;
      try {
        const stats = await consumer.getStats();
        stats.forEach(report => {
          if (report.type === "inbound-rtp") bytes = report.bytesReceived;
        });
      } catch {
        continue; // Closed underneath us; the next tick sees the truth.
      }
      if (bytes === null) continue;

      const seen = this._consumerBytes.get(consumer.id);
      if (seen && bytes <= seen.bytes) {
        seen.dead += 1;
        if (seen.dead >= SILENT_CONSUMER_SAMPLES) {
          silent.push(consumer.appData.peerId);
          seen.dead = 0;
        }
      } else {
        this._consumerBytes.set(consumer.id, { bytes, dead: 0 });
        // Audio is arriving from this person, so whatever was spent on them
        // earlier is forgiven: a second outage later deserves its own attempts.
        this._silentPeerRebuilds.delete(consumer.appData.peerId);
      }
    }

    if (silent.length === 0) return;
    this.emitRTCEvent(
      "warn",
      "RTC",
      () =>
        `Audio consumer delivering nothing for ${(SILENT_CONSUMER_SAMPLES * TRANSPORT_WATCHDOG_MS) / 1000}s: ${silent.join(", ")}`
    );

    // Its own budget, deliberately not _peerAudioWatch: that map is cleared
    // every tick for any peer who has a consumer at all, and a silent consumer
    // is still a consumer - sharing it would have reset the cap on each pass
    // and left nothing capped. Same reasoning as there, though: if rebuilding
    // twice did not bring this person's audio back, the fault is not one a
    // rebuild can reach, and further attempts only cost everyone else.
    const worth = silent.filter(peerId => {
      const used = this._silentPeerRebuilds.get(peerId) || 0;
      if (used >= 2) return false;
      this._silentPeerRebuilds.set(peerId, used + 1);
      return true;
    });
    if (worth.length === 0) return;
    this._scheduleRecvResync(`silent audio from ${worth.length} peer(s)`);
  }

  _scheduleRecvResync(reason) {
    if (this._recvResyncTimer || this._recvRecreateInProgress) return false;
    if (Date.now() - this._lastRecvResyncAt < RECV_RESYNC_MIN_INTERVAL_MS) return false;
    this._recvResyncTimer = setTimeout(async () => {
      this._recvResyncTimer = null;
      if (this._disposed || !this._protoo?.connected || this._recvRecreateInProgress) return;
      this._lastRecvResyncAt = Date.now();
      this.emitRTCEvent("warn", "RTC", () => `Rebuilding the receive transport: ${reason}`);
      try {
        const { host, port, turn } = this._serverParams;
        await this.recreateRecvTransport(this.getIceServers(host, port, turn));
      } catch (err) {
        this.emitRTCEvent("error", "RTC", () => `Receive rebuild failed: ${err}`);
      }
    }, RECV_RESYNC_DEBOUNCE_MS);
    return true;
  }

  disconnect() {
    debug("disconnect()");
    this._disposed = true;
    this._stopWatchdog();
    if (this._recvResyncTimer) {
      clearTimeout(this._recvResyncTimer);
      this._recvResyncTimer = null;
    }
    this.cleanUpLocalState();
    if (this._protoo) {
      this._protoo.removeAllListeners();
      if (this._protoo.connected) {
        this._protoo.close();
        this.emitRTCEvent("info", "Signaling", () => `[close]`);
      }
    }
  }

  kick(clientId) {
    return this._protoo
      .request("kick", {
        room_id: this.room,
        user_id: clientId,
        token: APP.hubChannel.token
      })
      .then(() => {
        document.body.dispatchEvent(new CustomEvent("kicked", { detail: { clientId: clientId } }));
      });
  }

  block(clientId) {
    return this._protoo.request("block", { whom: clientId }).then(() => {
      this._blockedClients.set(clientId, true);
      document.body.dispatchEvent(new CustomEvent("blocked", { detail: { clientId: clientId } }));
    });
  }

  unblock(clientId) {
    return this._protoo.request("unblock", { whom: clientId }).then(() => {
      this._blockedClients.delete(clientId);
      document.body.dispatchEvent(new CustomEvent("unblocked", { detail: { clientId: clientId } }));
    });
  }

  emitRTCEvent(level, tag, msgFunc) {
    const msg = msgFunc();
    // vegamix: the debug panel used to be the only reader, so with it closed
    // every one of these lines was thrown away - including the ones that say
    // exactly why somebody stopped being heard. Telemetry listens always.
    recordRtcEvent(level, tag, msg);
    if (!window.APP.store.state.preferences.showRtcDebugPanel) return;
    const time = new Date().toLocaleTimeString("en-US", {
      hour12: false,
      hour: "numeric",
      minute: "numeric",
      second: "numeric"
    });
    this.scene.emit("rtc_event", { level, tag, time, msg });
  }
}
