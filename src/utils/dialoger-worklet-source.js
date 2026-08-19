/**
 * AudioWorklet processor source, delivered as a string and loaded from a blob
 * URL.
 *
 * Why a blob rather than a bundled file: there is no AudioWorklet anywhere else
 * in this repo and no webpack rule for one, while Reticulum's CSP already
 * allows `script-src blob:` and `worker-src blob:`. That is zero build config
 * against one emitted asset plus a network round trip on the assets domain.
 *
 * Why the processor is this small: the tap runs on its own AudioContext pinned
 * to 16 kHz, so the browser does the resampling in `createMediaStreamSource`
 * and all that is left here is buffering 128-sample render quanta into the
 * 512-sample frames Dialoger's VAD demands, and converting to int16.
 *
 * Doing our own 48→16 decimation instead would need a low-pass first —
 * without one, 8–16 kHz energy folds down into the speech band. Whisper
 * tolerates that; silero does not.
 */
export const DIALOGER_WORKLET_NAME = "dialoger-tap";

export const DIALOGER_WORKLET_SOURCE = `
class DialogerTapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Dialoger's SpeechSegmenter.feed() rejects anything that is not exactly
    // 512 samples, and the server slices our batches back into that size.
    this.FRAME = 512;
    this.BATCH = 4;              // 2048 samples ≈ 128 ms per message
    this.buf = new Int16Array(this.FRAME * this.BATCH);
    this.filled = 0;
    this.muted = false;
    this.port.onmessage = e => {
      if (e.data && e.data.type === 'mute') this.muted = !!e.data.value;
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const ch = input[0];
    if (!ch) return true;

    for (let i = 0; i < ch.length; i++) {
      // Muted means silence on the wire, not a gap: the sample counter keeps
      // running so the recording stays aligned with the session timeline.
      const s = this.muted ? 0 : Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.filled === this.buf.length) {
        const out = this.buf.slice();
        this.port.postMessage({ pcm: out, count: out.length }, [out.buffer]);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('${DIALOGER_WORKLET_NAME}', DialogerTapProcessor);
`;

// Keyed by context: `addModule` registers into one AudioContext only, so a
// single cached promise would silently skip loading into a second one.
const loaded = new WeakMap();

export function ensureDialogerWorklet(ctx) {
  let promise = loaded.get(ctx);
  if (!promise) {
    const blob = new Blob([DIALOGER_WORKLET_SOURCE], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    promise = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    loaded.set(ctx, promise);
  }
  return promise;
}
