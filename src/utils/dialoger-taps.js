/**
 * Audio taps feeding a local Dialoger.
 *
 * One tap per person: the operator's own microphone plus every remote
 * participant we can hear. Each becomes its own channel, which is the whole
 * point of the integration — Dialoger gets speech already separated by speaker
 * and does not have to guess who said what.
 *
 * Where the local mic is tapped, and why:
 *
 *   APP.mediaDevicesManager.audioTrack is the raw getUserMedia track.
 *   audioSystem.outboundStream would go silent on mute for free, but it also
 *   carries screenshare audio — a demoed video's soundtrack would land in the
 *   meeting transcript. So we take the raw track and gate on mute explicitly.
 *   That also lets us say something honest to colleagues: muted means not
 *   recorded.
 *
 *   Muting in Hubs is `_micProducer.pause()` with `disableTrackOnPause`, which
 *   only disables the *outbound destination* track. The raw track stays live
 *   and enabled, so without the explicit gate we would record through mute.
 *
 * Where remote participants are tapped, and what that costs:
 *
 *   Straight off the mediasoup consumer, which is the only place their audio
 *   exists separately. Everything Hubs does to make people quieter — distance,
 *   personal mute, private zones, global voice volume — is gain further down
 *   the graph, so a tap here hears all of it regardless. That is what makes
 *   the recording clean, and it is also why the privacy gates below are not
 *   optional: without them someone who stepped into a private zone to talk
 *   would still be transcribed, which would quietly break a promise the room
 *   already makes.
 */
import { ensureDialogerWorklet, DIALOGER_WORKLET_NAME } from "./dialoger-worklet-source";
import { MediaDevicesEvents } from "./media-devices-utils";
import { getPresenceProfileForSession } from "./phoenix-utils";
import { getCurrentAudioSettings } from "../update-audio-settings";

export const LOCAL_PEER_KEY = "__local__";
const TARGET_SR = 16000;

/**
 * Remote audio tracks, read straight off the consumers.
 *
 * Never APP.dialog.getMediaStream(): that helper parks a promise which never
 * resolves when the peer is not producing, and a second call for the same peer
 * orphans the first — the promise avatar-audio-source is waiting on, so that
 * person goes silent for us until the page is reloaded. Same approach as
 * video-tiles.js.
 */
function remoteAudioTracks() {
  const out = new Map();
  const consumers = window.APP && window.APP.dialog && window.APP.dialog._consumers;
  if (!consumers) return out;
  consumers.forEach(consumer => {
    const peerId = consumer.appData && consumer.appData.peerId;
    if (!peerId || consumer.closed) return;
    const track = consumer.track;
    if (!track || track.readyState !== "live" || track.kind !== "audio") return;
    out.set(peerId, track);
  });
  return out;
}

function playerInfoFor(sessionId) {
  const infos = (window.APP && window.APP.componentRegistry && window.APP.componentRegistry["player-info"]) || [];
  for (const info of infos) {
    if (!info.isLocalPlayerInfo && info.playerSessionId === sessionId) return info;
  }
  return null;
}

/**
 * How loud this person is to us right now, or null if that cannot be answered.
 *
 * Deliberately asks the client's own audio settings rather than enumerating
 * the ways someone can be silenced. The first version listed them by hand —
 * private zone, personal mute — and missed scene audio zones entirely, so a
 * meeting held inside an isolated zone recorded the whole office along with
 * it. Every one of those mechanisms ends up as gain on this element, so the
 * effective gain is the honest answer to "is this person audible to me", and
 * it keeps being the answer when someone adds a new mechanism later.
 *
 * Distance is not part of it: attenuation is applied further along by the gain
 * system, and being across the room is not a privacy boundary.
 */
export function audibleGainFor(sessionId) {
  const info = playerInfoFor(sessionId);
  if (!info || !info.el) return null;
  const audioEl = info.el.querySelector("[avatar-audio-source]");
  if (!audioEl) return null;
  try {
    const settings = getCurrentAudioSettings(audioEl);
    if (!settings || typeof settings.gain !== "number") return null;
    return settings.gain;
  } catch (error) {
    console.warn("dialoger: could not read audio settings", error);
    return null;
  }
}

function displayNameFor(sessionId) {
  const presences = window.APP && window.APP.hubChannel && window.APP.hubChannel.presence?.state;
  const profile = presences && getPresenceProfileForSession(presences, sessionId);
  if (profile && profile.displayName) return profile.displayName;
  const info = playerInfoFor(sessionId);
  return (info && info.displayName) || sessionId.slice(0, 8);
}

export class DialogerTaps {
  constructor(client) {
    this.client = client;
    this.ctx = null;
    // key -> { peerId, kind, name, track, source, node, sink, el, channelId,
    //          sampleCursor, muted }
    this.taps = new Map();
    this._onMicState = this._onMicState.bind(this);
    this._onMicShareChanged = this._onMicShareChanged.bind(this);
    this._onStreamUpdated = this._onStreamUpdated.bind(this);
    this._tick = this._tick.bind(this);
    this._timer = null;
    // Attaching is asynchronous — a context, a worklet, a round trip to open
    // the channel — and syncRemote runs both on a timer and on stream events.
    // Without claiming the key up front, two overlapping passes each see "no
    // tap for this peer" and open a second channel for them: the same person
    // arrives twice, the second copy suffixed "(2)" by the name collision
    // rule. Hence a synchronous reservation, plus a guard so two passes never
    // interleave in the first place.
    this._attaching = new Set();
    this._syncing = false;
    this._syncAgain = false;
  }

  // Probed with `in` rather than by reading the property. audioWorklet is an
  // accessor on BaseAudioContext.prototype, so reading it off the prototype
  // object calls the getter with `this` set to the prototype itself, which is
  // not a live context — Chrome answers that with "Illegal invocation". This
  // getter is read during render, so the throw came out of React and took the
  // whole client down with it, for everyone, not just whoever had Dialoger
  // switched on. `in` walks the chain and never invokes the accessor.
  //
  // Wrapped as well because a feature probe that throws must not be able to do
  // that again: not being able to answer the question means the feature is not
  // available, and that is all the caller wants to know.
  static get supported() {
    try {
      return (
        typeof AudioContext !== "undefined" &&
        typeof AudioWorkletNode !== "undefined" &&
        "audioWorklet" in AudioContext.prototype
      );
    } catch (error) {
      console.warn("dialoger: could not probe for AudioWorklet support", error);
      return false;
    }
  }

  /**
   * A dedicated 16 kHz context, not the shared three.js one.
   *
   * The shared context runs at whatever the device gives (usually 48 kHz,
   * pinned nowhere), and 48→16 is not something we want to do by hand: naive
   * decimation folds 8–16 kHz energy into the speech band and silero starts
   * missing speech. With the context pinned to 16 kHz the browser resamples
   * inside createMediaStreamSource and the worklet only has to buffer.
   */
  async _ensureContext() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: TARGET_SR });
      await ensureDialogerWorklet(this.ctx);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
    return this.ctx;
  }

  /** Session-relative index of the next sample, so late joiners line up. */
  _cursorNow() {
    const startedAtMs = this.client.startedAtMs;
    if (!startedAtMs) return 0;
    return Math.max(0, Math.round(((Date.now() - startedAtMs) / 1000) * TARGET_SR));
  }

  async start() {
    await this.startLocal();
    const scene = window.APP && window.APP.scene;
    if (scene) {
      scene.addEventListener(MediaDevicesEvents.MIC_SHARE_STARTED, this._onMicShareChanged);
      scene.addEventListener(MediaDevicesEvents.MIC_SHARE_ENDED, this._onMicShareChanged);
    }
    if (window.APP && window.APP.dialog) {
      window.APP.dialog.on("mic-state-changed", this._onMicState);
      // Consumer tracks are swapped wholesale on ICE recovery, and this is the
      // only event that says so.
      window.APP.dialog.on("stream_updated", this._onStreamUpdated);
    }
    // Backstop poll. Not decoration: removeConsumer emits nothing at all, so
    // peers leaving would otherwise go unnoticed. It also re-evaluates the
    // privacy gates, which depend on positions that move every frame.
    this._timer = setInterval(this._tick, 1000);
    this._tick();
  }

  _tick() {
    this.syncRemote().catch(e => console.warn("dialoger: remote sync failed", e));
    this._applyGates();
  }

  // ------------------------------------------------------------ attachment

  async _attach(key, { stream, name, kind, peerId }) {
    // Claimed before the first await, released only once the tap is in the
    // map — that window is exactly where the duplicates came from.
    if (this.taps.has(key) || this._attaching.has(key)) return null;
    this._attaching.add(key);
    try {
      return await this._attachInner(key, { stream, name, kind, peerId });
    } finally {
      this._attaching.delete(key);
    }
  }

  async _attachInner(key, { stream, name, kind, peerId }) {
    const ctx = await this._ensureContext();

    // Chrome will not pull samples out of a WebRTC-sourced track into WebAudio
    // unless the stream is also attached to an <audio> element. Mandatory for
    // remote peers; harmless for the local gUM track.
    const el = new Audio();
    el.srcObject = stream;
    el.muted = true;
    el.volume = 0;
    el.play().catch(() => {});

    const source = ctx.createMediaStreamSource(stream);
    // One output, wired to a muted sink, rather than the tidier
    // `numberOfOutputs: 0`. Web Audio renders by pulling from the destination,
    // and a node on no path to it is not guaranteed to be processed at all —
    // the tap would go silent with nothing in the console to show for it.
    // The output is left as silence, and the zero gain keeps it that way.
    const node = new AudioWorkletNode(ctx, DIALOGER_WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1
    });
    const sink = ctx.createGain();
    sink.gain.value = 0;

    const firstSample = this._cursorNow();
    const channelId = await this.client.openChannel({ peerId, name, kind, firstSample });
    if (channelId == null) {
      source.disconnect();
      el.pause();
      el.srcObject = null;
      return null;
    }

    const state = {
      peerId,
      kind,
      name,
      track: stream.getAudioTracks()[0] || null,
      source,
      node,
      sink,
      el,
      channelId,
      sampleCursor: firstSample,
      muted: null
    };
    node.port.onmessage = ev => {
      const pcm = ev.data && ev.data.pcm;
      if (!pcm) return;
      this.client.sendAudio(state.channelId, state.sampleCursor, pcm);
      state.sampleCursor += pcm.length;
    };
    source.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);
    this.taps.set(key, state);
    // Decide audibility immediately: the worklet starts muted, so this is what
    // lets a legitimately audible person through without waiting for the tick.
    this._applyGates();
    return state;
  }

  _detach(key) {
    const state = this.taps.get(key);
    if (!state) return;
    this.taps.delete(key);
    try {
      state.source.disconnect();
      state.node.port.onmessage = null;
      state.node.disconnect();
      state.sink.disconnect();
    } catch {
      /* nodes may already be detached */
    }
    // The stock code leaks these elements forever (see the TODO in
    // avatar-audio-source.js); do not copy that.
    state.el.pause();
    state.el.srcObject = null;
    this.client.closeChannel(state.peerId);
  }

  /** Swap the stream under an existing tap, keeping its channel and cursor. */
  async _reattachStream(state, stream) {
    const ctx = await this._ensureContext();
    try {
      state.source.disconnect();
    } catch {
      /* already gone */
    }
    state.el.srcObject = stream;
    state.el.play().catch(() => {});
    state.source = ctx.createMediaStreamSource(stream);
    state.source.connect(state.node);
    state.track = stream.getAudioTracks()[0] || null;
  }

  // ----------------------------------------------------------------- local

  async startLocal() {
    if (this.taps.has(LOCAL_PEER_KEY)) return;
    const track = window.APP?.mediaDevicesManager?.audioTrack;
    if (!track) {
      console.warn("dialoger: no microphone track to tap");
      return;
    }
    const name = window.APP?.store?.state?.profile?.displayName || "Me";
    await this._attach(LOCAL_PEER_KEY, {
      stream: new MediaStream([track]),
      name,
      kind: "local",
      peerId: LOCAL_PEER_KEY
    });
    this._applyGates();
  }

  _onMicState() {
    this._applyGates();
  }

  async _onMicShareChanged() {
    const state = this.taps.get(LOCAL_PEER_KEY);
    // The mic track object is replaced wholesale on every device switch and on
    // "ended", so a tap bound to the old one would go quiet without a word.
    const track = window.APP?.mediaDevicesManager?.audioTrack;
    if (!state || !track) return;
    await this._reattachStream(state, new MediaStream([track]));
    this._applyGates();
  }

  // ---------------------------------------------------------------- remote

  _onStreamUpdated(peerId, kind) {
    if (kind && kind !== "audio") return;
    this.syncRemote().catch(e => console.warn("dialoger: reattach failed", e));
  }

  async syncRemote() {
    if (!this.client || !this.client.recording) return;
    // One pass at a time. A second pass starting mid-flight would race the
    // first over the same peers; remember that another is wanted and run it
    // after, so nothing that arrived meanwhile is missed either.
    if (this._syncing) {
      this._syncAgain = true;
      return;
    }
    this._syncing = true;
    try {
      await this._syncRemoteOnce();
    } finally {
      this._syncing = false;
    }
    if (this._syncAgain) {
      this._syncAgain = false;
      await this.syncRemote();
    }
  }

  async _syncRemoteOnce() {
    const tracks = remoteAudioTracks();

    for (const [peerId, track] of tracks) {
      const existing = this.taps.get(peerId);
      if (!existing) {
        await this._attach(peerId, {
          stream: new MediaStream([track]),
          name: displayNameFor(peerId),
          kind: "remote",
          peerId
        });
        continue;
      }
      if (existing.track !== track) {
        await this._reattachStream(existing, new MediaStream([track]));
      }
      // Renaming in Hubs rewrites history on Dialoger's side, so the
      // transcript ends up consistently under the new name.
      const name = displayNameFor(peerId);
      if (name && name !== existing.name) {
        existing.name = name;
        this.client.renameChannel(peerId, name);
      }
    }

    for (const key of Array.from(this.taps.keys())) {
      if (key === LOCAL_PEER_KEY) continue;
      if (!tracks.has(key)) this._detach(key);
    }
  }

  // ------------------------------------------------------------------ gates

  /**
   * Decide, per tap, whether frames should carry audio or silence.
   *
   * Silence rather than nothing at all: the sample counter keeps running, so
   * the recording stays aligned with the session timeline and a gated stretch
   * shows up as a gap in the right place instead of shifting everything after
   * it.
   */
  _applyGates() {
    for (const [key, state] of this.taps) {
      let muted;
      if (key === LOCAL_PEER_KEY) {
        muted = !window.APP?.dialog?.isMicEnabled;
      } else {
        const gain = audibleGainFor(state.peerId);
        // Fail closed. An unknown answer means we cannot show this person is
        // audible to us, and "record them anyway" is the wrong way to resolve
        // that doubt — it is how a meeting inside an isolated zone ended up
        // with the whole office in the transcript. The usual cause is a peer
        // whose consumer arrived before their avatar did, which resolves by
        // itself within a tick.
        muted = gain === null || gain <= 0.0001;
      }
      if (muted !== state.muted) {
        state.muted = muted;
        state.node.port.postMessage({ type: "mute", value: !!muted });
        if (state.kind === "remote") {
          console.info("dialoger: %s is now %s", state.name, muted ? "not recorded" : "recorded");
        }
      }
    }
  }

  // -------------------------------------------------------------- teardown

  async stopAll() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    const scene = window.APP && window.APP.scene;
    if (scene) {
      scene.removeEventListener(MediaDevicesEvents.MIC_SHARE_STARTED, this._onMicShareChanged);
      scene.removeEventListener(MediaDevicesEvents.MIC_SHARE_ENDED, this._onMicShareChanged);
    }
    try {
      window.APP.dialog.off("mic-state-changed", this._onMicState);
      window.APP.dialog.off("stream_updated", this._onStreamUpdated);
    } catch {
      /* adapter already torn down */
    }
    for (const key of Array.from(this.taps.keys())) this._detach(key);
    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch {
        /* already closed */
      }
      this.ctx = null;
    }
  }
}
