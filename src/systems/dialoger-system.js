/**
 * Ties the Dialoger client, the audio taps and the room lifecycle together.
 *
 * Deliberately not an A-Frame tick system: nothing here needs per-frame work,
 * and a heartbeat on a timer is fine because it is only liveness signalling —
 * the audio itself is driven by the AudioWorklet, which keeps running at full
 * rate even when the tab is in the background. Timers do get throttled there;
 * audio must never depend on one.
 */
import { DialogerClient, DIALOGER_STATE } from "../utils/dialoger-client";
import { DialogerTaps } from "../utils/dialoger-taps";

const HEARTBEAT_MS = 5000;

export class DialogerSystem {
  constructor() {
    this.client = null;
    this.taps = null;
    this._hb = null;
    this._startWhenReady = false;
    this._onClientChanged = this._onClientChanged.bind(this);
    this._onBeforeUnload = this._onBeforeUnload.bind(this);
  }

  get state() {
    return this.client ? this.client.state : DIALOGER_STATE.OFFLINE;
  }

  get available() {
    return DialogerTaps.supported;
  }

  _prefs() {
    const p = window.APP?.store?.state?.preferences || {};
    return {
      enabled: !!p.dialogerEnabled,
      baseUrl: p.dialogerUrl || "http://127.0.0.1:8765",
      token: p.dialogerToken || "",
      transport: p.dialogerTransport || "bridge"
    };
  }

  /**
   * Opens the transport. MUST be called straight from a click handler: the
   * bridge transport calls window.open, and after an await the transient user
   * activation is gone and the popup blocker takes it.
   *
   * `startWhenReady` makes one click enough. Connecting is asynchronous —
   * the bridge window has to load, open its socket and get past the
   * handshake — but nobody pressing a record button wants to learn that:
   * they pressed Rec, so we remember the intent and act on it the moment the
   * handshake lands.
   */
  connect({ startWhenReady = false } = {}) {
    const prefs = this._prefs();
    if (!prefs.enabled) return false;
    if (!this.client) {
      this.client = new DialogerClient(prefs);
      this.client.addEventListener("changed", this._onClientChanged);
      this.taps = new DialogerTaps(this.client);
      window.addEventListener("beforeunload", this._onBeforeUnload);
    }
    this._startWhenReady = startWhenReady;
    const opened = this.client.connect();
    // Popup blocked, or no transport at all: drop the intent rather than let
    // it fire on some later, unrelated connection.
    if (!opened) this._startWhenReady = false;
    return opened;
  }

  /**
   * What the toolbar button does: connect if needed, then toggle.
   *
   * OFFLINE and ERROR both mean "there is nothing usable to talk through" —
   * a closed bridge window lands in the first, a refused handshake in the
   * second. Both have to rebuild the transport, or the button stays dead
   * until the page is reloaded.
   */
  press() {
    const state = this.client && this.client.state;
    if (!this.client || state === DIALOGER_STATE.OFFLINE || state === DIALOGER_STATE.ERROR) {
      this.connect({ startWhenReady: true });
      return;
    }
    this.toggleRecording();
  }

  startRecording() {
    if (!this.client) return;
    const hubName = window.APP?.hub?.name || "Офис";
    this.client.startSession(`${hubName} — ${new Date().toLocaleString("ru-RU")}`);
  }

  toggleRecording() {
    if (!this.client) return;
    if (this.client.recording) {
      this.stopRecording();
    } else {
      this.startRecording();
    }
  }

  stopRecording() {
    if (this.client) this.client.stopSession();
  }

  _onClientChanged() {
    const recording = this.client.recording;
    if (recording && !this._hb) this._onRecordingStarted();
    if (!recording && this._hb) this._onRecordingStopped();
    // The handshake finished after a click that asked for recording — honour
    // it now. READY is the only state worth acting on: an error or a dropped
    // connection must not silently start a session later on.
    if (this._startWhenReady && this.client.state === DIALOGER_STATE.READY) {
      this._startWhenReady = false;
      this.startRecording();
    }
    window.APP?.scene?.emit("dialoger_state_changed", { state: this.client.state });
  }

  _onRecordingStarted() {
    this._hb = setInterval(() => this.client.heartbeat(), HEARTBEAT_MS);
    // Taps own their own reconciliation from here: the local mic, everyone
    // audible in the room, and the privacy gates that decide which of them
    // reach the recording.
    this.taps.start().catch(e => console.warn("dialoger: failed to start taps", e));
    // Stock Reticulum recording flag: puts a red badge over the operator's
    // name tag for everyone in the room. That is exactly the consent signal
    // this feature needs, and it costs one call.
    try {
      window.APP.hubChannel.beginRecording();
    } catch (e) {
      console.warn("dialoger: beginRecording failed", e);
    }
  }

  _onRecordingStopped() {
    clearInterval(this._hb);
    this._hb = null;
    if (this.taps) this.taps.stopAll().catch(() => {});
    try {
      window.APP.hubChannel.endRecording();
    } catch {
      /* channel may be gone already */
    }
  }

  _onBeforeUnload() {
    if (this.client && this.client.recording) {
      this.client.stopSession();
      try {
        window.APP.hubChannel.endRecording();
      } catch {
        /* leaving anyway */
      }
    }
  }

  disconnect() {
    if (this._hb) this._onRecordingStopped();
    window.removeEventListener("beforeunload", this._onBeforeUnload);
    if (this.client) {
      this.client.removeEventListener("changed", this._onClientChanged);
      this.client.disconnect();
    }
    this.client = null;
    this.taps = null;
  }
}
