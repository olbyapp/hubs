// Webcams and screenshares are presented as DOM tiles in both the 2D and the 3D
// view, so the quads carrying the same streams around the room are redundant
// clutter and stay hidden. VR is the exception — there is no DOM overlay in a
// headset — so the camera system restores them while in VR.
//
// Both calls are idempotent and are made every frame rather than on transitions.
// Edge-triggered was not enough: quads spawn at any moment, the media loader
// rewrites `visible` while one is loading, and a quad left hidden by a missed
// transition stays hidden for the whole session — which reads as a screenshare
// that is invisible to everyone.
//
// Avatar-face cameras are untouched by design: those are a texture swap on the
// avatar mesh (video-texture-target), not a spawned entity, so they never show
// up in the listed-media roster we walk here.

const hiddenEntities = [];

function isClientVideo(el) {
  // listed-media can register an entity before its media-loader exists.
  const mediaLoader = el.components && el.components["media-loader"];
  const src = (mediaLoader && mediaLoader.data && mediaLoader.data.src) || "";
  return src.startsWith("hubs://") && src.endsWith("/video");
}

function listedMediaElements() {
  const scene = AFRAME.scenes[0];
  const system = scene && scene.systems["listed-media"];
  return (system && system.els) || [];
}

// Picks up quads spawned while the mode is already on, and re-applies the hidden
// state: spawning media flips visible off and back on once its orientation
// resolves, and the bitECS loader rewrites it every frame while loading.
export function hideClientVideoObjects() {
  for (const el of listedMediaElements()) {
    if (!el.object3D || hiddenEntities.includes(el) || !isClientVideo(el)) continue;
    hiddenEntities.push(el);
  }
  for (const el of hiddenEntities) {
    if (el.object3D && el.object3D.visible) {
      el.object3D.visible = false;
    }
  }
}

export function restoreClientVideoObjects() {
  if (!hiddenEntities.length) return;
  for (const el of hiddenEntities) {
    if (el.object3D) {
      el.object3D.visible = true;
    }
  }
  hiddenEntities.length = 0;
}
