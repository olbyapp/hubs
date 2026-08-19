/**
 * Transport to a Dialoger instance running on the operator's own machine.
 *
 * The room page cannot open `ws://localhost` itself: Reticulum serves a CSP
 * with `default-src 'none'` and an explicit `connect-src` allowlist, and
 * loosening it means editing the production config. CSP does not govern
 * `window.open` or `postMessage`, though, so we relay through a small window
 * served by Dialoger itself — for that window `ws://localhost:8765` is
 * same-origin and no policy applies.
 *
 * Two implementations behind one interface:
 *   BridgeTransport  — the popup relay described above. Default.
 *   DirectWsTransport — plain WebSocket. Only works once the CSP on the server
 *                       has been widened; kept so switching is a preference
 *                       change rather than a rewrite.
 */

const BRIDGE_WINDOW_NAME = "dialoger-bridge";

class BaseTransport {
  constructor({ onMessage, onStatus }) {
    this.onMessage = onMessage || (() => {});
    this.onStatus = onStatus || (() => {});
  }

  open() {
    throw new Error("not implemented");
  }
  sendControl() {
    throw new Error("not implemented");
  }
  sendAudio() {
    throw new Error("not implemented");
  }
  close() {}
  get connected() {
    return false;
  }
}

export class BridgeTransport extends BaseTransport {
  /**
   * @param {string} baseUrl Origin of the local Dialoger, e.g. http://127.0.0.1:8765
   */
  constructor({ baseUrl, onMessage, onStatus }) {
    super({ onMessage, onStatus });
    this.baseUrl = (baseUrl || "http://127.0.0.1:8765").replace(/\/$/, "");
    this.win = null;
    this.ready = false;
    this.wsOpen = false;
    this.dropped = 0;
    this._onWindowMessage = this._onWindowMessage.bind(this);
  }

  /**
   * MUST be called straight from a click handler. `window.open` after an
   * `await` loses the transient user activation and the popup blocker eats it.
   */
  open() {
    window.addEventListener("message", this._onWindowMessage);
    this.win = window.open(`${this.baseUrl}/bridge`, BRIDGE_WINDOW_NAME, "width=420,height=260");
    if (!this.win) {
      this.onStatus({ state: "error", error: "popup_blocked" });
      return false;
    }
    this.onStatus({ state: "opening" });
    return true;
  }

  get connected() {
    return this.ready && this.wsOpen && !!this.win && !this.win.closed;
  }

  _post(msg, transfer) {
    if (!this.win || this.win.closed) {
      this.onStatus({ state: "error", error: "bridge_closed" });
      return false;
    }
    try {
      this.win.postMessage(msg, this.baseUrl, transfer || []);
      return true;
    } catch (e) {
      console.warn("dialoger: postMessage failed", e);
      return false;
    }
  }

  sendControl(payload) {
    this._post({ k: "ctrl", payload });
  }

  /**
   * @param {ArrayBuffer} buffer Framed PCM. Ownership moves to the bridge —
   *   do not touch it afterwards.
   */
  sendAudio(buffer) {
    if (!this.connected) {
      // Dropping is deliberate: the audio path must never block or queue
      // without bound. Gaps are self-healing because every frame carries an
      // absolute sample index.
      this.dropped++;
      return;
    }
    this._post({ k: "audio", buf: buffer }, [buffer]);
  }

  _onWindowMessage(ev) {
    if (ev.origin !== this.baseUrl) return;
    const d = ev.data;
    if (!d || typeof d !== "object") return;

    if (d.k === "bridge") {
      if (d.event === "ready") {
        this.ready = true;
        // The bridge only learns our origin from an inbound message, and until
        // it does it cannot answer. Ping so it can report the socket state.
        this._post({ k: "ping", ts: Date.now() });
      } else if (d.event === "ws_open") {
        this.wsOpen = true;
        this.onStatus({ state: "connected" });
      } else if (d.event === "ws_connecting") {
        this.wsOpen = false;
        this.onStatus({ state: "opening" });
      } else if (d.event === "ws_closed") {
        this.wsOpen = false;
        this.onStatus({ state: "disconnected" });
      } else if (d.event === "closing") {
        this.wsOpen = false;
        this.ready = false;
        this.onStatus({ state: "disconnected", error: "bridge_closed" });
      }
      return;
    }
    if (d.k === "srv") this.onMessage(d.payload);
  }

  close() {
    window.removeEventListener("message", this._onWindowMessage);
    if (this.win && !this.win.closed) this.win.close();
    this.win = null;
    this.ready = false;
    this.wsOpen = false;
  }
}

export class DirectWsTransport extends BaseTransport {
  constructor({ baseUrl, onMessage, onStatus }) {
    super({ onMessage, onStatus });
    this.url = (baseUrl || "http://127.0.0.1:8765").replace(/^http/, "ws").replace(/\/$/, "") + "/ws/office";
    this.ws = null;
    this.dropped = 0;
  }

  open() {
    this.onStatus({ state: "opening" });
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.ws = ws;
      this.onStatus({ state: "connected" });
    };
    ws.onmessage = ev => {
      try {
        this.onMessage(JSON.parse(ev.data));
      } catch (e) {
        console.warn("dialoger: bad server frame", e);
      }
    };
    ws.onclose = () => {
      this.ws = null;
      this.onStatus({ state: "disconnected" });
    };
    ws.onerror = () => this.onStatus({ state: "error", error: "ws_error" });
    return true;
  }

  get connected() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  sendControl(payload) {
    if (this.connected) this.ws.send(JSON.stringify(payload));
  }

  sendAudio(buffer) {
    if (!this.connected) {
      this.dropped++;
      return;
    }
    // Never let the socket buffer grow without bound: if the machine cannot
    // keep up, losing audio beats losing the connection. ~1 MB is about 30 s
    // of one channel.
    if (this.ws.bufferedAmount > 1_000_000) {
      this.dropped++;
      return;
    }
    this.ws.send(buffer);
  }

  close() {
    if (this.ws) this.ws.close();
    this.ws = null;
  }
}

export function createTransport(kind, opts) {
  return kind === "direct" ? new DirectWsTransport(opts) : new BridgeTransport(opts);
}
