/**
 * Audio taps feeding a local Dialoger.
 *
 * Stage 4 taps the local microphone only; remote participants come in stage 5
 * together with the privacy gating they require (a raw consumer tap bypasses
 * private zones and per-person mute, which would silently break both).
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
 */
import { ensureDialogerWorklet, DIALOGER_WORKLET_NAME } from "./dialoger-worklet-source";
import { MediaDevicesEvents } from "./media-devices-utils";

export const LOCAL_PEER_KEY = "__local__";
const TARGET_SR = 16000;

export class DialogerTaps {
  constructor(client) {
    this.client = client;
    this.ctx = null;
    this.local = null; // { source, node, el, channelId, sampleCursor }
    this._onMicState = this._onMicState.bind(this);
    this._onMicShareChanged = this._onMicShareChanged.bind(this);
  }

  static get supported() {
    return typeof AudioContext !== "undefined" && !!AudioContext.prototype.audioWorklet;
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

  async startLocal() {
    if (this.local) return;
    const track = window.APP?.mediaDevicesManager?.audioTrack;
    if (!track) {
      console.warn("dialoger: no microphone track to tap");
      return;
    }

    const ctx = await this._ensureContext();
    const stream = new MediaStream([track]);

    // Chrome will not pull samples out of a WebRTC-sourced track into WebAudio
    // unless the stream is also attached to an <audio> element. The local mic
    // is a gUM track rather than a remote one, so this is belt and braces here,
    // but it costs nothing and stage 5 needs the same helper for real.
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

    const name = window.APP?.store?.state?.profile?.displayName || "Me";
    const channelId = await this.client.openChannel({
      peerId: LOCAL_PEER_KEY,
      name,
      kind: "local",
      firstSample: 0
    });
    if (channelId == null) {
      source.disconnect();
      el.pause();
      el.srcObject = null;
      return;
    }

    const state = { source, node, sink, el, channelId, sampleCursor: 0 };
    node.port.onmessage = ev => {
      const pcm = ev.data && ev.data.pcm;
      if (!pcm) return;
      this.client.sendAudio(state.channelId, state.sampleCursor, pcm);
      state.sampleCursor += pcm.length;
    };
    source.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);
    this.local = state;

    this._applyMuteToWorklet();
    window.APP.dialog.on("mic-state-changed", this._onMicState);
    // The mic track object is replaced wholesale on every device switch and on
    // "ended", so a tap bound to the old one would go quiet without a word.
    const scene = window.APP.scene;
    if (scene) {
      scene.addEventListener(MediaDevicesEvents.MIC_SHARE_STARTED, this._onMicShareChanged);
      scene.addEventListener(MediaDevicesEvents.MIC_SHARE_ENDED, this._onMicShareChanged);
    }
  }

  _applyMuteToWorklet() {
    if (!this.local) return;
    const enabled = window.APP?.dialog?.isMicEnabled;
    this.local.node.port.postMessage({ type: "mute", value: !enabled });
  }

  _onMicState() {
    this._applyMuteToWorklet();
  }

  async _onMicShareChanged() {
    if (!this.local) return;
    // Reattach to the new track, keeping the channel and the sample cursor:
    // the session timeline must not restart just because a device changed.
    const track = window.APP?.mediaDevicesManager?.audioTrack;
    if (!track) return;
    const ctx = await this._ensureContext();
    const stream = new MediaStream([track]);
    try {
      this.local.source.disconnect();
    } catch {
      /* already gone */
    }
    this.local.el.srcObject = stream;
    this.local.el.play().catch(() => {});
    this.local.source = ctx.createMediaStreamSource(stream);
    this.local.source.connect(this.local.node);
    this._applyMuteToWorklet();
  }

  stopLocal() {
    if (!this.local) return;
    const { source, node, sink, el } = this.local;
    try {
      window.APP.dialog.off("mic-state-changed", this._onMicState);
    } catch {
      /* adapter already torn down */
    }
    const scene = window.APP.scene;
    if (scene) {
      scene.removeEventListener(MediaDevicesEvents.MIC_SHARE_STARTED, this._onMicShareChanged);
      scene.removeEventListener(MediaDevicesEvents.MIC_SHARE_ENDED, this._onMicShareChanged);
    }
    try {
      source.disconnect();
      node.port.onmessage = null;
      node.disconnect();
      sink.disconnect();
    } catch {
      /* nodes may already be detached */
    }
    // The stock code leaks these elements forever (see the TODO in
    // avatar-audio-source.js); do not copy that.
    el.pause();
    el.srcObject = null;
    this.client.closeChannel(LOCAL_PEER_KEY);
    this.local = null;
  }

  async stopAll() {
    this.stopLocal();
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
