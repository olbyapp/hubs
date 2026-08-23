import { MediaDevicesEvents } from "./media-devices-utils";

// Turn off what a backgrounded tab has no business still sending: nobody expects to
// still be heard, or seen, after switching to another tab or minimising the window.
//
// The three streams are NOT equivalent, and the difference decides the design:
//
// - Microphone and camera can be restored without asking. getUserMedia does not need
//   a user gesture once permission is granted, so we can put them back exactly as we
//   found them when the person returns.
// - A screen share cannot. getDisplayMedia requires a transient user activation, so
//   anything we stop here is stopped for good - the person has to press Share again.
//   That makes stopping it a much heavier decision, and it gets a grace period.
//
// Screen sharing also has a workflow that directly conflicts with this feature: when
// somebody shares a browser tab, they switch to that tab, which backgrounds Hubs for
// as long as they are presenting. Those shares are left alone entirely.

// How long the tab must stay hidden before a screen share is given up. Long enough
// that flicking to another tab and back does not cost a share you cannot restore.
const SCREEN_SHARE_GRACE_MS = 60000;

let scene = null;
let screenShareTimer = null;

// What was on when the tab went away, so it can be put back.
const suspended = {
  mic: false,
  camera: false
};

function mediaDevicesManager() {
  return window.APP && window.APP.mediaDevicesManager;
}

// Chrome reports what kind of surface is being shared. A shared browser tab means the
// person is about to go and look at it, so backgrounding Hubs is expected, not idle.
function isSharingBrowserTab(manager) {
  const stream = manager._mediaStream;
  if (!stream) return false;
  return stream.getVideoTracks().some(track => {
    const settings = typeof track.getSettings === "function" ? track.getSettings() : null;
    return settings && settings.displaySurface === "browser";
  });
}

function onHidden() {
  const manager = mediaDevicesManager();
  if (!manager || !scene) return;

  if (manager.isMicEnabled) {
    suspended.mic = true;
    manager.micEnabled = false;
  }

  if (manager.isVideoShared) {
    if (manager.isWebcamShared) {
      suspended.camera = true;
      scene.emit(MediaDevicesEvents.VIDEO_SHARE_ENDED);
    } else if (manager.isScreenShared && !isSharingBrowserTab(manager)) {
      clearTimeout(screenShareTimer);
      screenShareTimer = setTimeout(() => {
        // Re-check: the tab may have come back, or the share may already be over.
        if (document.visibilityState !== "hidden") return;
        const current = mediaDevicesManager();
        if (current && current.isVideoShared && current.isScreenShared) {
          console.log("Stopping the screen share: the tab has been in the background for a while.");
          scene.emit(MediaDevicesEvents.VIDEO_SHARE_ENDED);
        }
      }, SCREEN_SHARE_GRACE_MS);
    }
  }
}

function onVisible() {
  clearTimeout(screenShareTimer);
  screenShareTimer = null;

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

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      onHidden();
    } else {
      onVisible();
    }
  });

  // A stream the person stopped by hand while we were hidden must not come back when
  // they return, so forget our note as soon as they take over.
  scene.addEventListener(MediaDevicesEvents.VIDEO_SHARE_ENDED, () => {
    if (document.visibilityState === "visible") suspended.camera = false;
  });
}
