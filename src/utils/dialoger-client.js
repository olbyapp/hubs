/**
 * Protocol layer for talking to a local Dialoger over a transport.
 *
 * Owns the handshake, the session lifecycle and the binary framing. Knows
 * nothing about where audio comes from — see dialoger-taps.js for that.
 */
import { createTransport } from "./dialoger-transport";

const HEADER_SIZE = 16;
export const PROTO_VERSION = 1;

/**
 * Frame layout (little-endian), mirroring server/office.py:
 *   0      uint8   version
 *   1      uint8   flags (bit0: 0 = int16 payload)
 *   2..3   uint16  channelId
 *   4..11  uint64  firstSample — absolute index in the session's 16 kHz timeline
 *   12..15 uint32  sampleCount
 *   16..   int16[] PCM
 *
 * The absolute index is what makes gaps harmless: a late joiner, a dropped
 * frame, a reconnect and a closed bridge are all the same thing to the server,
 * and it can pad the recording to keep every channel aligned.
 */
export function buildAudioFrame(channelId, firstSample, int16) {
  const buf = new ArrayBuffer(HEADER_SIZE + int16.length * 2);
  const dv = new DataView(buf);
  dv.setUint8(0, PROTO_VERSION);
  dv.setUint8(1, 0);
  dv.setUint16(2, channelId, true);
  dv.setBigUint64(4, BigInt(firstSample), true);
  dv.setUint32(12, int16.length, true);
  new Int16Array(buf, HEADER_SIZE).set(int16);
  return buf;
}

export const DIALOGER_STATE = {
  OFFLINE: "offline",
  CONNECTING: "connecting",
  READY: "ready",
  STARTING: "starting",
  RECORDING: "recording",
  ERROR: "error"
};

export class DialogerClient extends EventTarget {
  constructor({ baseUrl, token, transport = "bridge" }) {
    super();
    this.baseUrl = baseUrl;
    this.token = token;
    this.transportKind = transport;
    this.transport = null;
    this.state = DIALOGER_STATE.OFFLINE;
    this.sessionId = null;
    this.error = null;
    this.whisperLag = 0;
    this.startedAtMs = null;
    // peerId -> channelId, handed out by the server on channel_open.
    this.channels = new Map();
    this._pendingOpens = new Map();
    this._helloSent = false;
  }

  _setState(state, error = null) {
    this.state = state;
    this.error = error;
    this.dispatchEvent(new CustomEvent("changed"));
  }

  /**
   * Must run synchronously inside a click handler (popup blocker).
   *
   * A transport that exists is not the same as one that works: closing the
   * bridge window leaves a dead object behind, and returning early on its mere
   * presence made the button unrecoverable — every later press posted into a
   * closed window and failed silently, until the page was reloaded. So a spent
   * transport gets thrown away and rebuilt.
   */
  connect() {
    if (this.transport) {
      const usable =
        this.transport.connected ||
        this.state === DIALOGER_STATE.CONNECTING ||
        this.state === DIALOGER_STATE.STARTING ||
        this.state === DIALOGER_STATE.RECORDING;
      if (usable) return true;
      this.transport.close();
      this.transport = null;
      this._helloSent = false;
      this.sessionId = null;
      this.channels.clear();
    }
    this.transport = createTransport(this.transportKind, {
      baseUrl: this.baseUrl,
      onMessage: msg => this._onServerMessage(msg),
      onStatus: st => this._onTransportStatus(st)
    });
    this._setState(DIALOGER_STATE.CONNECTING);
    return this.transport.open();
  }

  disconnect() {
    if (this.transport) this.transport.close();
    this.transport = null;
    this._helloSent = false;
    this.sessionId = null;
    this.channels.clear();
    this._setState(DIALOGER_STATE.OFFLINE);
  }

  get recording() {
    return this.sessionId != null;
  }

  get droppedFrames() {
    return this.transport ? this.transport.dropped : 0;
  }

  _onTransportStatus(st) {
    if (st.state === "connected") {
      if (!this._helloSent) {
        this._helloSent = true;
        this.transport.sendControl({
          t: "hello",
          proto: PROTO_VERSION,
          token: this.token,
          room: window.APP?.hub?.hub_id,
          room_name: window.APP?.hub?.name
        });
      }
    } else if (st.state === "disconnected") {
      this._helloSent = false;
      this.sessionId = null;
      this.channels.clear();
      this._setState(DIALOGER_STATE.OFFLINE, st.error || null);
    } else if (st.state === "error") {
      this._setState(DIALOGER_STATE.ERROR, st.error);
    }
  }

  _onServerMessage(msg) {
    switch (msg.t) {
      case "hello_ok":
        this.sessionId = msg.active_session_id ?? null;
        this._setState(this.sessionId ? DIALOGER_STATE.RECORDING : DIALOGER_STATE.READY);
        break;
      case "session_started":
        this.sessionId = msg.session_id;
        this.startedAtMs = Date.now();
        this._setState(DIALOGER_STATE.RECORDING);
        this.dispatchEvent(new CustomEvent("session_started"));
        break;
      case "session_stopped":
        this.sessionId = null;
        this.channels.clear();
        this._setState(DIALOGER_STATE.READY);
        this.dispatchEvent(new CustomEvent("session_stopped"));
        break;
      case "channel_opened": {
        const peerId = msg.peer_id;
        if (peerId) this.channels.set(peerId, msg.ch);
        const pending = this._pendingOpens.get(peerId);
        if (pending) {
          this._pendingOpens.delete(peerId);
          pending(msg.ch);
        }
        break;
      }
      case "state":
        this.whisperLag = msg.whisper_lag || 0;
        if ((msg.active_session_id ?? null) !== this.sessionId) {
          // The operator may have stopped the session from Dialoger's own UI.
          this.sessionId = msg.active_session_id ?? null;
          this._setState(this.sessionId ? DIALOGER_STATE.RECORDING : DIALOGER_STATE.READY);
        } else {
          this.dispatchEvent(new CustomEvent("changed"));
        }
        break;
      case "error":
        this._setState(DIALOGER_STATE.ERROR, msg.code);
        break;
    }
  }

  startSession(title) {
    if (!this.transport) return;
    this._setState(DIALOGER_STATE.STARTING);
    this.transport.sendControl({ t: "session_start", title });
  }

  stopSession() {
    if (!this.transport) return;
    this.transport.sendControl({ t: "session_stop" });
  }

  heartbeat() {
    if (!this.transport) return;
    this.transport.sendControl({ t: "hb", dropped_frames: this.droppedFrames });
  }

  /** Resolves with the numeric channel id assigned by the server. */
  openChannel({ peerId, name, kind, firstSample }) {
    if (!this.transport || !this.recording) return Promise.resolve(null);
    if (this.channels.has(peerId)) return Promise.resolve(this.channels.get(peerId));
    return new Promise(resolve => {
      this._pendingOpens.set(peerId, resolve);
      this.transport.sendControl({
        t: "channel_open",
        peer_id: peerId,
        name,
        kind,
        first_sample: firstSample
      });
    });
  }

  closeChannel(peerId) {
    const ch = this.channels.get(peerId);
    if (ch == null || !this.transport) return;
    this.channels.delete(peerId);
    this.transport.sendControl({ t: "channel_close", ch });
  }

  renameChannel(peerId, name) {
    const ch = this.channels.get(peerId);
    if (ch == null || !this.transport) return;
    this.transport.sendControl({ t: "channel_rename", ch, name });
  }

  sendAudio(channelId, firstSample, int16) {
    if (!this.transport) return;
    this.transport.sendAudio(buildAudioFrame(channelId, firstSample, int16));
  }
}
