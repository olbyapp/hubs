// User status (vegamix): shared through profile presence meta, so it needs no
// Reticulum-side changes — any profile change is auto-broadcast by hub-channel's
// "profilechanged" listener.
import { MediaDevicesEvents } from "./media-devices-utils";

export const USER_STATUSES = ["none", "work", "eat", "thinking", "afk", "custom"];

// Shown on nametags. Keep ASCII — the MSDF nametag font has no emoji glyphs.
// "custom" has no entry on purpose: its label is whatever its owner typed, so
// it is drawn from a canvas instead (see statusLabelFor and status-icons).
export const STATUS_LABELS = {
  none: "ONLINE",
  work: "WORK",
  eat: "EAT",
  thinking: "THINKING",
  afk: "AFK"
};

export const STATUS_DISPLAY_NAMES = {
  none: "Online",
  work: "Work",
  eat: "Eat",
  thinking: "Thinking",
  afk: "AFK",
  // Only ever shown where the text itself is missing; everywhere a custom
  // status is rendered normally, the text stands in for this.
  custom: "Custom"
};

export const STATUS_COLORS = {
  none: "#7ED320",
  work: "#7ED320",
  eat: "#FFC107",
  thinking: "#FFC107",
  afk: "#FF3464",
  custom: "#B57BFF"
};

// Longest custom status anyone can set. Enforced on the way in and again on the
// way out: the text rides presence, so it arrives from clients we do not
// control and a nametag is in no position to argue with a novel.
export const CUSTOM_STATUS_MAX_LENGTH = 100;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

// Everything a custom status has to survive before it is shown: control
// characters and newlines would break a single-line label, and the limit is
// counted in code points so an emoji costs one character rather than two and
// can never be cut in half.
export function sanitizeStatusText(text) {
  if (typeof text !== "string") return "";
  const oneLine = text.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  return Array.from(oneLine).slice(0, CUSTOM_STATUS_MAX_LENGTH).join("");
}

// The line a status puts under a name. Empty means "this status has nothing to
// say" — Online, or a custom status whose text did not survive sanitising —
// and every caller uses that to decide whether the row exists at all.
export function statusLabelFor(status, statusText) {
  if (status === "custom") return sanitizeStatusText(statusText);
  return (status && STATUS_LABELS[status]) || "";
}

// Quiet statuses silence incoming voice + media and turn off mic/camera.
// "afk" additionally refuses incoming calls (checked by caller and callee).
// A custom status is deliberately not one of them: it says where someone is,
// not that they have stepped away, and silencing on a free-text status would
// be a surprise nobody asked for.
const QUIET_STATUSES = ["thinking", "afk"];

let savedVolumes = null;
let autoOnlineWatcherInstalled = false;

export function getOwnStatus() {
  return (window.APP.store.state.profile && window.APP.store.state.profile.status) || "none";
}

// Kept even while another status is picked, so reopening the custom-status
// dialog offers back what was typed last time instead of an empty field. Only
// read when the status actually is "custom".
export function getOwnStatusText() {
  return sanitizeStatusText(window.APP.store.state.profile && window.APP.store.state.profile.statusText);
}

export function isQuietStatus(status) {
  return QUIET_STATUSES.includes(status);
}

// Turning the mic or camera back on while in a quiet status means "I'm back":
// switch to Online automatically so volumes come back too.
function installAutoOnlineWatcher() {
  if (autoOnlineWatcherInstalled) return;
  autoOnlineWatcherInstalled = true;
  const backToOnline = () => {
    if (isQuietStatus(getOwnStatus())) setOwnStatus("none");
  };
  if (window.APP.dialog) {
    window.APP.dialog.on("mic-state-changed", ({ enabled }) => {
      if (enabled) backToOnline();
    });
  }
  const scene = document.querySelector("a-scene");
  if (scene) {
    scene.addEventListener(MediaDevicesEvents.VIDEO_SHARE_STARTED, backToOnline);
  }
}

export function setOwnStatus(status, statusText) {
  if (!USER_STATUSES.includes(status)) return;
  const store = window.APP.store;
  const prev = getOwnStatus();

  if (status === "custom") {
    // For a custom status the text *is* the status, so editing it while
    // already custom has to go through — the "nothing changed" guard below
    // would otherwise swallow every edit after the first.
    const text = sanitizeStatusText(statusText);
    if (!text) return;
    if (status === prev && text === getOwnStatusText()) return;
    store.update({ profile: { status, statusText: text } });
  } else {
    if (status === prev) return;
    store.update({ profile: { status } });
  }

  const becameQuiet = isQuietStatus(status) && !isQuietStatus(prev);
  const leftQuiet = !isQuietStatus(status) && isQuietStatus(prev);

  if (becameQuiet) {
    const prefs = store.state.preferences;
    savedVolumes = {
      voice: prefs.globalVoiceVolume !== undefined ? prefs.globalVoiceVolume : 100,
      media: prefs.globalMediaVolume !== undefined ? prefs.globalMediaVolume : 100
    };
    store.update({ preferences: { globalVoiceVolume: 0, globalMediaVolume: 0 } });
    const mdm = window.APP.mediaDevicesManager;
    if (mdm) {
      if (mdm.isMicEnabled) mdm.micEnabled = false;
      mdm.stopVideoShare().catch(() => {});
    }
    installAutoOnlineWatcher();
  } else if (leftQuiet) {
    store.update({
      preferences: {
        globalVoiceVolume: savedVolumes ? savedVolumes.voice : 100,
        globalMediaVolume: savedVolumes ? savedVolumes.media : 100
      }
    });
    savedVolumes = null;
    // Mic and camera are not auto-restored here; turning either back on is
    // itself the "I'm back" signal handled by installAutoOnlineWatcher().
  }
}
