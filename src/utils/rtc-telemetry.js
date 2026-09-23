// Voice-path telemetry (vegamix): every RTC event the adapter already narrates
// is batched and posted to hub-stats, so "X перестал слышать Y в четверг" can be
// answered from the server instead of asking the person to reproduce it with the
// debug panel open. The adapter's emitRTCEvent used to drop every line unless the
// panel was on screen; now the panel stays optional and this always listens.
//
// Same trust model and transport as office-stats.js: same-origin POST through
// host-nginx, no CORS, no preflight, stdlib service on the other end. Volume is
// tiny - a healthy hour of a session is a handful of state changes plus one
// snapshot a minute - so the cost is a request every fifteen seconds at worst.

const POST_INTERVAL_MS = 15000;
const SNAPSHOT_INTERVAL_MS = 60000;
// After a failed post, wait longer each time - the service being down must not
// add its own traffic to whatever is already wrong with the network.
const RETRY_BACKOFF_MS = [15000, 30000, 60000, 120000, 300000];
// A buffer this deep means the service has been unreachable for a while; older
// events are the ones a reload would have lost anyway.
const MAX_BUFFERED_EVENTS = 500;
const MAX_EVENTS_PER_POST = 200;
// Consecutive repeats of the same line within this window collapse into one
// event with a count - connectionstatechange can flap fast on a bad link, and
// the flapping itself is the signal, not each individual line.
const DEDUP_WINDOW_MS = 5000;

const DEFAULT_BASE = "/office-stats";

function baseUrl() {
  const override = new URLSearchParams(window.location.search).get("statsBase");
  return (override || DEFAULT_BASE).replace(/\/$/, "");
}

function randomId() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const sessionId = randomId().replace(/-/g, "").slice(0, 32);

// Read at post time rather than once at startup: people rename themselves, and
// the profile is not loaded yet when the first events are recorded.
function name() {
  try {
    return (window.APP.store.state.profile || {}).displayName || null;
  } catch {
    return null;
  }
}

// readyState/enabled/muted of the track the microphone producer is sending.
function micTrackState(dialog) {
  try {
    const producer = dialog._micProducer;
    if (!producer) return null;
    const track = producer.track;
    if (!track) return "no-track";
    return `${track.readyState}${track.enabled ? "" : ",disabled"}${track.muted ? ",muted" : ""}${
      producer.paused ? ",producer-paused" : ""
    }`;
  } catch {
    return null;
  }
}

let buffer = [];
let dropped = 0;
let lastEvent = null;
let timer = null;
let snapshotTimer = null;
let inflight = false;
let failures = 0;
let postDueAt = 0;

export function recordRtcEvent(level, tag, msg) {
  const now = Date.now();

  if (
    lastEvent &&
    lastEvent.level === level &&
    lastEvent.tag === tag &&
    lastEvent.msg === msg &&
    now - lastEvent.t < DEDUP_WINDOW_MS
  ) {
    lastEvent.n = (lastEvent.n || 1) + 1;
    lastEvent.t = now;
    return;
  }

  lastEvent = { t: now, level, tag, msg };
  buffer.push(lastEvent);
  if (buffer.length > MAX_BUFFERED_EVENTS) {
    buffer.splice(0, buffer.length - MAX_BUFFERED_EVENTS);
    dropped += 1;
  }
  // The one knot in an otherwise top-down file: recording starts the loop, the
  // loop takes snapshots, snapshots are recorded.
  // eslint-disable-next-line no-use-before-define
  ensureStarted();
}

// One line a minute describing what a healthy session looks like, so the log of
// a broken one has a baseline right next to it. Reads the adapter's internals
// the same way media-devices-manager already does; if a rename over there makes
// a field vanish, the snapshot degrades to nulls rather than throwing.
function snapshot() {
  try {
    const dialog = window.APP && window.APP.dialog;
    if (!dialog) return;

    let peersInRoom = null;
    try {
      const state = window.APP.hubChannel.presence.state;
      peersInRoom = Object.keys(state).filter(id => {
        const meta = state[id].metas && state[id].metas[0];
        return meta && meta.presence === "room";
      }).length;
    } catch {
      // Presence not up yet; the counts we do have are still worth the line.
    }

    let audioConsumers = 0;
    dialog._consumers &&
      dialog._consumers.forEach(consumer => {
        if (consumer.track && consumer.track.kind === "audio") audioConsumers += 1;
      });

    recordRtcEvent(
      "info",
      "Snapshot",
      JSON.stringify({
        signaling: !!(dialog._protoo && dialog._protoo.connected),
        send: (dialog._sendTransport && dialog._sendTransport.connectionState) || null,
        recv: (dialog._recvTransport && dialog._recvTransport.connectionState) || null,
        mic: dialog._micProducer ? (dialog._micProducer.paused ? "paused" : "live") : "none",
        consumers: (dialog._consumers && dialog._consumers.size) || 0,
        audioConsumers,
        peersInRoom,
        // The output side. Everything above says whether the bytes arrived;
        // these say whether anything came out of the speakers. ctx is the audio
        // context state, peak is the level leaving the mixer, and arriving is
        // the voice that landed in the last watchdog tick - a healthy session
        // records what healthy looks like, which is what a broken one has to be
        // read against.
        ctx: dialog._playback ? dialog._playback.ctxState : null,
        peak: dialog._playback ? dialog._playback.peak : null,
        arriving: dialog._playback ? dialog._playback.arriving : null,
        // Two taps on the microphone, and the gap between them is the answer
        // to "I can see it working but nobody hears me". micPeak is the tap on
        // the microphone itself, which keeps reading while muted by design -
        // it is what the level bar in the UI shows, and today's log has it at
        // p90 = 32 muted against 76 live, the same range either way, so it
        // proves the hardware works and nothing else. txPeak sits on the bus
        // feeding the encoder: what shows up there is what leaves the machine.
        micPeak: dialog._playback ? dialog._playback.micPeak : null,
        txPeak: dialog._playback ? dialog._playback.txPeak : null,
        // The state of the track actually being sent. _setLocalMediaStream
        // stops the outgoing track before replacing it, and the outgoing track
        // is the single one belonging to the Web Audio MediaStreamDestination -
        // stop that and it cannot be revived, so the producer stays "live" and
        // sends silence for the rest of the session while every level meter
        // upstream of it keeps moving. That is the shape of "I can see my
        // microphone working and nobody hears me", and this is the field that
        // would prove or kill it: an "ended" here with micPeak above zero says
        // it outright.
        micTrack: micTrackState(dialog)
      })
    );
  } catch {
    // A snapshot must never be the thing that breaks the room.
  }
}

function payload(events) {
  const context = {
    v: 1,
    sessionId,
    // Which build is speaking. Without it, telling an old tab from a fresh one
    // means inferring it from side effects - on 2026-09-04 that meant reading
    // the log level of an unrelated line, a signal that vanishes as soon as
    // everyone reloads.
    build: process.env.BUILD_VERSION || "?",
    // Who this is. Tying a session to a person used to mean matching its start
    // time against the visit journal by hand - about five minutes of archaeology
    // per question, and only possible at all because people join at distinct
    // moments. The office already shows these names to each other and the
    // journal already stores them.
    name: name(),
    ts: Date.now(),
    roomId: (window.APP && window.APP.hub && window.APP.hub.hub_id) || null,
    peerId: (window.APP && window.APP.dialog && window.APP.dialog._clientId) || null,
    ua: navigator.userAgent
  };
  if (dropped > 0) {
    context.dropped = dropped;
  }
  return { ...context, events };
}

async function post() {
  if (inflight || buffer.length === 0) return;
  const events = buffer.slice(0, MAX_EVENTS_PER_POST);
  inflight = true;
  try {
    const response = await fetch(`${baseUrl()}/api/rtc-log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload(events))
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    // Only drop what was sent; anything recorded during the request survives.
    buffer = buffer.slice(events.length);
    if (lastEvent && !buffer.includes(lastEvent)) lastEvent = null;
    dropped = 0;
    failures = 0;
    postDueAt = Date.now() + POST_INTERVAL_MS;
  } catch {
    failures = Math.min(failures + 1, RETRY_BACKOFF_MS.length);
    postDueAt = Date.now() + RETRY_BACKOFF_MS[failures - 1];
  } finally {
    inflight = false;
  }
}

function flushOnExit() {
  if (buffer.length === 0 || !navigator.sendBeacon) return;
  try {
    navigator.sendBeacon(
      `${baseUrl()}/api/rtc-log`,
      new Blob([JSON.stringify(payload(buffer.slice(-MAX_EVENTS_PER_POST)))], { type: "application/json" })
    );
    buffer = [];
    lastEvent = null;
  } catch {
    // Nothing useful to do on the way out.
  }
}

// Started lazily by the first event rather than by scene entry: the events most
// worth having - "Unable to connect to this room" - happen before any scene
// entry, and the tab is often closed straight from that screen.
function ensureStarted() {
  if (timer) return;
  postDueAt = Date.now() + POST_INTERVAL_MS;
  timer = setInterval(() => {
    if (Date.now() >= postDueAt) post();
  }, 1000);
  snapshotTimer = setInterval(snapshot, SNAPSHOT_INTERVAL_MS);
  window.addEventListener("pagehide", flushOnExit);
}

export function stopRtcTelemetry() {
  if (timer) clearInterval(timer);
  if (snapshotTimer) clearInterval(snapshotTimer);
  timer = null;
  snapshotTimer = null;
  window.removeEventListener("pagehide", flushOnExit);
  flushOnExit();
}
