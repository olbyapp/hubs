// What this screen-orientation-utils does are
// 1. Hide the screen orientation API difference across browsers
//    ScreenOrientation API should be used but Safari doesn't support it yet.
//    Instead deprecated window.orientation and orientationchange event
//    need to be used on Safari for now.
// 2. Manage maxResolution preferences values based on the screen orientation

import { isIOS as detectIOS } from "./is-mobile";

const isIOS = detectIOS();

export const addOrientationChangeListener = (callback, useCapture = false) => {
  if (typeof ScreenOrientation !== "undefined") {
    screen.orientation.addEventListener("change", callback, useCapture);
  } else {
    window.addEventListener("orientationchange", callback, useCapture);
  }
};

export const removeOrientationChangeListener = (callback, useCapture = false) => {
  if (typeof ScreenOrientation !== "undefined") {
    screen.orientation.removeEventListener("change", callback, useCapture);
  } else {
    window.removeEventListener("orientationchange", callback, useCapture);
  }
};

const getAngle = () => {
  return typeof ScreenOrientation !== "undefined" ? screen.orientation.angle : window.orientation;
};

const isNaturalOrientation = () => {
  return getAngle() % 180 === 0;
};

// Return the screen width in CSS pixels based on the current screen orientation
const getScreenWidth = () => {
  // Is seems screen.width value is based on the natural screen orientation on iOS
  // while it is based on the current screen orientation on Android (and other devices?).
  if (isIOS) {
    return isNaturalOrientation() ? screen.width : screen.height;
  }
  return screen.width;
};

// Return the screen height in CSS pixels based on the current screen orientation
const getScreenHeight = () => {
  // Is seems screen.height value is based on the natural screen orientation on iOS
  // while it is based on the current screen orientation on Android (and other devices?).
  if (isIOS) {
    return isNaturalOrientation() ? screen.height : screen.width;
  }
  return screen.height;
};

// Return the screen resolution width in physical pixels based on the current screen orientation
export const getScreenResolutionWidth = () => {
  return getScreenWidth() * window.devicePixelRatio;
};

// Return the screen resolution height in physical pixels based on the current screen orientation
export const getScreenResolutionHeight = () => {
  return getScreenHeight() * window.devicePixelRatio;
};

// vegamix: these are documented - and consumed - as PHYSICAL pixels: useResizeViewport
// divides them by devicePixelRatio to get a CSS-pixel canvas size. Stock returned CSS
// pixels here instead, so the division happened a second time and the canvas came out
// at 1/devicePixelRatio of the screen: 393 / 3 = 131 px wide on an iPhone, then
// stretched back over the full screen. That is why mobile always looked soft, and why
// raising the pixel ratio never helped - a larger ratio only made maxWidth smaller by
// the same factor, so the two cancelled exactly.
//
// The original intent was to keep the fragment count down. That is what the pixel ratio
// is for, and auto-pixel-ratio now lowers it from measured frame rate on mobile too, so
// the resolution cap can simply be the screen.
const getDefaultMaxResolutionWidth = () => {
  return getScreenResolutionWidth();
};

// See the comment above
const getDefaultMaxResolutionHeight = () => {
  return getScreenResolutionHeight();
};

// Take width and height based on the current screen orientation and
// store them based on natural orientation.
// Width and height paremeters must be in physical pixels.
export const setMaxResolution = (store, width, height) => {
  store.update({
    preferences: {
      maxResolutionWidth: isNaturalOrientation() ? width : height,
      maxResolutionHeight: isNaturalOrientation() ? height : width
    }
  });
};

// Return max resolution width in physical pixels
// based on the current screen orientation
export const getMaxResolutionWidth = store => {
  const preferences = store.state.preferences;
  const width = isNaturalOrientation() ? preferences.maxResolutionWidth : preferences.maxResolutionHeight;
  return width !== undefined ? width : getDefaultMaxResolutionWidth();
};

// Return max resolution height in physical pixels
// based on the current screen orientation
export const getMaxResolutionHeight = store => {
  const preferences = store.state.preferences;
  const height = isNaturalOrientation() ? preferences.maxResolutionHeight : preferences.maxResolutionWidth;
  return height !== undefined ? height : getDefaultMaxResolutionHeight();
};
