// User status (vegamix): shared through profile presence meta, so it needs no
// Reticulum-side changes — any profile change is auto-broadcast by hub-channel's
// "profilechanged" listener.
import { MediaDevicesEvents } from "./media-devices-utils";

export const USER_STATUSES = ["none", "work", "eat", "thinking", "afk"];

// Shown on nametags. Keep ASCII — the MSDF nametag font has no emoji glyphs.
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
  afk: "AFK"
};

export const STATUS_COLORS = {
  none: "#7ED320",
  work: "#7ED320",
  eat: "#FFC107",
  thinking: "#FFC107",
  afk: "#FF3464"
};

// Quiet statuses silence incoming voice + media and turn off mic/camera.
// "afk" additionally refuses incoming calls (checked by caller and callee).
const QUIET_STATUSES = ["thinking", "afk"];

let savedVolumes = null;
let autoOnlineWatcherInstalled = false;

export function getOwnStatus() {
  return (window.APP.store.state.profile && window.APP.store.state.profile.status) || "none";
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

export function setOwnStatus(status) {
  if (!USER_STATUSES.includes(status)) return;
  const store = window.APP.store;
  const prev = getOwnStatus();
  if (status === prev) return;

  store.update({ profile: { status } });

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
