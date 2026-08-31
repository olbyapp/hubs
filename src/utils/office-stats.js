// Weekly office statistics (vegamix): each client measures only itself and
// posts the deltas to hub-stats, which adds them up per person per week and
// says who wins each award. See AIContext/hub-stats/ for the service and
// achievements.js for what the awards are.
//
// Measured here, all about the local user only:
//   presence — time in the room (not the lobby)
//   talk     — time with the mic on and voiced energy on it
//   walk     — metres travelled on the floor plane, teleports excluded
//   afk      — time in the AFK status
//   thinking — time in the Thinking status
//   eat      — time in the Eat status
//
// Why a plain interval rather than a scene system on the render tick: the
// render loop stops in a background tab, and someone listening to a meeting
// with the tab behind their editor is still in the office. An interval keeps
// ticking (throttled to about once a second, which is why every metric is
// derived from a wall-clock delta rather than from a fixed step). The two
// metrics that would be wrong to accrue while hidden are handled explicitly:
// walking cannot happen with the render loop stopped, and voiced time is
// measured off the Web Audio graph, which really does keep running.

import { calculateVolume } from "../components/audio-feedback";
import { getOwnStatus } from "./user-status";
import { ACHIEVEMENT_PRIORITY } from "./achievements";

// Same floor the mic meter and the muted-mic notice use, so all three agree
// about what counts as talking.
const TALK_VOLUME_THRESHOLD = 0.05;
const TALK_SMOOTHING = 0.3;

const SAMPLE_MS = 1000;
const POST_INTERVAL_MS = 20000;

// A sample longer than this is a suspended laptop or a clock jump, not time
// spent in the office. The service refuses to credit it either.
const MAX_SAMPLE_MS = 5000;

// Teleports, waypoints and respawns all move the rig instantly. Anything
// faster than this over one sample is not walking.
const MAX_WALK_SPEED_M_S = 8;

// A tab that has been hidden this long has been left behind rather than
// listened to; presence stops accruing until it comes back.
const HIDDEN_GRACE_MS = 15 * 60 * 1000;

// After a failed post, wait longer each time rather than hammering a service
// that is down — capped so a recovered service is picked up within minutes.
const RETRY_BACKOFF_MS = [20000, 40000, 80000, 160000, 300000];

const ANON_KEY_STORAGE = "vegamix-office-stats-anon-id";

// Same origin as the client (host-nginx proxies it), so posts need no CORS
// preflight. ?statsBase= overrides it while developing against a local one.
const DEFAULT_BASE = "/office-stats";

function baseUrl() {
  const override = new URLSearchParams(window.location.search).get("statsBase");
  return (override || DEFAULT_BASE).replace(/\/$/, "");
}

function randomId() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Signed-in people are the same person on every device and in every browser;
// anyone else gets a key that at least survives a reload of this browser.
function userKey() {
  const accountId = window.APP.store.credentialsAccountId;
  if (accountId) return `acct:${accountId}`;
  let anon = null;
  try {
    anon = window.localStorage.getItem(ANON_KEY_STORAGE);
    if (!anon) {
      anon = randomId().replace(/-/g, "").slice(0, 24);
      window.localStorage.setItem(ANON_KEY_STORAGE, anon);
    }
  } catch {
    // Private mode, or storage the browser will not hand out: the key lasts
    // for this page load only, which costs the person their week rather than
    // breaking the room.
    anon = randomId().replace(/-/g, "").slice(0, 24);
  }
  return `anon:${anon}`;
}

const pending = { talk_ms: 0, walk_mm: 0, afk_ms: 0, thinking_ms: 0, eat_ms: 0 };
const listeners = new Set();

// When the idle-detector last saw this person do anything (input or voice).
// Rides on every post as idleMs, so hub-stats can hold a quiet stretch aside
// and credit it only if the person wakes up; a stretch that instead ends in
// the five-hour idle exit is never counted — no presence, no journal end
// time, no achievements.
let lastActivityAt = Date.now();

let started = false;
let sessionId = null;
let seq = 0;
let spanMs = 0;
let lastSampleAt = 0;
let hiddenSince = 0;
let smoothedVolume = 0;
let lastPosition = null;
let postDueAt = 0;
let failures = 0;
let inflight = false;

// Last word from the service: which awards this user holds, most wearable
// first, and who holds each award across the office.
let myAchievements = [];
let officeAchievements = {};

export function getMyAchievements() {
  return myAchievements;
}

export function getOfficeAchievements() {
  return officeAchievements;
}

// Returns an unsubscribe function, so React effects can just return it.
export function onOfficeStatsChanged(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.warn("office-stats: listener failed", error);
    }
  }
}

// The award goes into the profile rather than being looked up per person:
// profile changes are already broadcast to everyone through presence, so a
// name tag can read its owner's award without this service knowing anything
// about who is in which room.
function publishOwnAchievement() {
  const store = window.APP.store;
  // All of them, most wearable first, as one comma-separated string: name tags
  // draw an icon per award, so the whole set has to travel, and presence
  // carries a profile string without Reticulum needing to know what it means.
  const worn = myAchievements.join(",");
  const profile = store.state.profile || {};
  if ((profile.achievement || "") === worn) return;
  store.update({ profile: { achievement: worn, achievementCount: Math.max(0, myAchievements.length - 1) } });
}

function inTheRoom() {
  const scene = AFRAME.scenes[0];
  return !!scene && scene.is("entered");
}

function presenceCounts() {
  if (document.visibilityState === "visible") {
    hiddenSince = 0;
    return true;
  }
  if (!hiddenSince) hiddenSince = Date.now();
  return Date.now() - hiddenSince < HIDDEN_GRACE_MS;
}

function talkingNow() {
  const scene = AFRAME.scenes[0];
  const audioSystem = scene && scene.systems["hubs-systems"] && scene.systems["hubs-systems"].audioSystem;
  const mediaDevicesManager = window.APP.mediaDevicesManager;
  // A muted mic is not talking, and the raw mic analyser is used rather than
  // the outbound one so a screen share's audio is never mistaken for a voice.
  if (!audioSystem || !audioSystem.micAnalyser || !mediaDevicesManager || !mediaDevicesManager.isMicEnabled) {
    smoothedVolume = 0;
    return false;
  }
  const raw = calculateVolume(audioSystem.micAnalyser, audioSystem.micAnalyserLevels);
  smoothedVolume = TALK_SMOOTHING * raw + (1 - TALK_SMOOTHING) * smoothedVolume;
  return smoothedVolume > TALK_VOLUME_THRESHOLD;
}

function walkedMm(dtMs) {
  const rig = document.getElementById("avatar-rig");
  if (!rig) return 0;
  const position = rig.object3D.position;
  const previous = lastPosition;
  lastPosition = { x: position.x, z: position.z };
  if (!previous) return 0;
  // Floor plane only: falling off a ledge or riding a lift is not walking.
  const dx = position.x - previous.x;
  const dz = position.z - previous.z;
  const metres = Math.sqrt(dx * dx + dz * dz);
  if (metres > (MAX_WALK_SPEED_M_S * dtMs) / 1000) return 0;
  return Math.round(metres * 1000);
}

function payload() {
  return {
    sessionId,
    userKey: userKey(),
    displayName: (window.APP.store.state.profile && window.APP.store.state.profile.displayName) || "",
    seq: seq + 1,
    spanMs,
    idleMs: Math.max(0, Date.now() - lastActivityAt),
    deltas: { ...pending }
  };
}

function clearPending() {
  spanMs = 0;
  pending.talk_ms = 0;
  pending.walk_mm = 0;
  pending.afk_ms = 0;
  pending.thinking_ms = 0;
  pending.eat_ms = 0;
}

async function post() {
  if (spanMs <= 0) {
    postDueAt = Date.now() + POST_INTERVAL_MS;
    return;
  }
  const body = payload();
  inflight = true;
  try {
    const response = await fetch(`${baseUrl()}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();

    // Only now is the window it covered safely accounted for: a failed post
    // keeps its deltas so a blip in the service costs nobody their minutes.
    seq = body.seq;
    clearPending();
    failures = 0;
    postDueAt = Date.now() + POST_INTERVAL_MS;

    const mine = Array.isArray(result.yours) ? result.yours : [];
    const changed = mine.join(",") !== myAchievements.join(",");
    myAchievements = mine.slice().sort((a, b) => ACHIEVEMENT_PRIORITY.indexOf(a) - ACHIEVEMENT_PRIORITY.indexOf(b));
    officeAchievements = result.achievements || {};
    publishOwnAchievement();
    if (changed) notify();
  } catch (error) {
    const wait = RETRY_BACKOFF_MS[Math.min(failures, RETRY_BACKOFF_MS.length - 1)];
    failures += 1;
    postDueAt = Date.now() + wait;
    // One line per failure would fill the console during an outage; the first
    // is the useful one.
    if (failures === 1) console.warn("office-stats: post failed, backing off", error);
  } finally {
    inflight = false;
  }
}

function sample() {
  const now = Date.now();
  const dt = Math.min(now - lastSampleAt, MAX_SAMPLE_MS);
  lastSampleAt = now;

  if (!inTheRoom()) {
    // Left the room or never entered: drop the walking baseline so re-entering
    // somewhere else does not read as a sprint across the office.
    lastPosition = null;
    return;
  }
  if (!presenceCounts()) return;

  spanMs += dt;
  if (talkingNow()) pending.talk_ms += dt;

  const status = getOwnStatus();
  if (status === "afk") pending.afk_ms += dt;
  if (status === "thinking") pending.thinking_ms += dt;
  if (status === "eat") pending.eat_ms += dt;

  pending.walk_mm += walkedMm(dt);

  if (now >= postDueAt && !inflight) post();
}

// Closing the tab is the one moment fetch cannot be relied on. sendBeacon
// survives it, and the service's sequence check means a beacon that races the
// last ordinary post cannot be counted twice.
function flushOnExit() {
  if (spanMs <= 0 || !navigator.sendBeacon) return;
  try {
    navigator.sendBeacon(
      `${baseUrl()}/api/ingest`,
      new Blob([JSON.stringify(payload())], { type: "application/json" })
    );
    seq += 1;
    clearPending();
  } catch {
    // Nothing useful to do on the way out.
  }
}

export function startOfficeStats() {
  if (started) return;
  started = true;
  sessionId = randomId().replace(/-/g, "").slice(0, 32);
  lastSampleAt = Date.now();
  // First post soon after entering, so a name tag shows its award without
  // waiting out a full interval.
  postDueAt = Date.now() + 5000;

  setInterval(sample, SAMPLE_MS);
  window.addEventListener("activity_detected", () => {
    lastActivityAt = Date.now();
  });
  window.addEventListener("pagehide", flushOnExit);
  // pagehide does not fire on every mobile browser; visibilitychange does.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushOnExit();
  });
}
