import { MediaDevicesEvents } from "./media-devices-utils";

// Two things happen when the tab stops being looked at.
//
// 1. The microphone and camera go off. Nobody expects to still be heard or seen
//    after switching to another tab or minimising the window, and both come back
//    exactly as they were on return - getUserMedia needs no user gesture once
//    permission has been granted.
//
//    Unless a screen share is running. Presenting and then going to look at what
//    you are presenting is the normal way to use it, and you are usually talking
//    over it, so a share suppresses all of this: mic, camera and the share itself
//    are left alone. (It could not restore a stopped share anyway - getDisplayMedia
//    requires a user gesture, so stopping one is a one-way door.)
//
// 2. The state is published so everyone else can see it. It rides in profile
//    presence meta, the same way user status does, so it needs no Reticulum
//    changes: hub-channel re-broadcasts the profile on every change.

let scene = null;

// What was on when the tab went away, so it can be put back.
const suspended = {
  mic: false,
  camera: false
};

function mediaDevicesManager() {
  return window.APP && window.APP.mediaDevicesManager;
}

function isScreenSharing() {
  const manager = mediaDevicesManager();
  return !!manager && manager.isVideoShared && manager.isScreenShared;
}

export function isPageHidden() {
  return document.visibilityState === "hidden";
}

function publishHidden(hidden) {
  const store = window.APP && window.APP.store;
  if (!store) return;
  const current = !!(store.state.profile && store.state.profile.hidden);
  if (current === hidden) return;
  store.update({ profile: { hidden } });
}

function onHidden() {
  publishHidden(true);

  const manager = mediaDevicesManager();
  if (!manager || !scene) return;

  // Presenting: leave everything running, including the microphone.
  if (isScreenSharing()) return;

  if (manager.isMicEnabled) {
    suspended.mic = true;
    manager.micEnabled = false;
  }

  if (manager.isVideoShared) {
    suspended.camera = true;
    scene.emit(MediaDevicesEvents.VIDEO_SHARE_ENDED);
  }
}

function onVisible() {
  publishHidden(false);

  const manager = mediaDevicesManager();
  if (!manager || !scene) return;

  if (suspended.mic) {
    suspended.mic = false;
    manager.micEnabled = true;
  }

  if (suspended.camera) {
    suspended.camera = false;
    // Only if nothing else took over the single video slot while we were away.
    if (!manager.isVideoShared) {
      scene.emit("action_share_camera");
    }
  }
}

/**
 * @param {object} sceneEl the A-Frame scene, used to drive sharing through the same
 *   events the toolbar uses so its state stays in step with ours.
 */
export function startBackgroundMediaGuard(sceneEl) {
  scene = sceneEl;

  // The profile is persisted, so a tab closed while hidden would otherwise come
  // back claiming to be hidden until the first visibility change.
  publishHidden(isPageHidden());

  document.addEventListener("visibilitychange", () => {
    if (isPageHidden()) {
      onHidden();
    } else {
      onVisible();
    }
  });

  // A camera the person switched off by hand while we were away must not come back
  // when they return, so drop our note as soon as they take over.
  scene.addEventListener(MediaDevicesEvents.VIDEO_SHARE_ENDED, () => {
    if (!isPageHidden()) suspended.camera = false;
  });
}
