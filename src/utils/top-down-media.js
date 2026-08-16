// In 2D the webcam and screenshare quads standing around the room are just
// clutter seen from above — the same streams are already in the tile panel — so
// top-down hides them and restores them on the way out.
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

// Safe to call repeatedly: picks up objects spawned while the mode is already on.
export function hideClientVideoObjects() {
  for (const el of listedMediaElements()) {
    if (!el.object3D || hiddenEntities.includes(el) || !isClientVideo(el)) continue;
    hiddenEntities.push(el);
  }
  reassertHiddenClientVideoObjects();
}

// Spawning media flips visible off and back on once its orientation resolves,
// and the bitECS loader rewrites it every frame while loading, so the hidden
// state has to be re-applied rather than set once.
export function reassertHiddenClientVideoObjects() {
  for (const el of hiddenEntities) {
    if (el.object3D && el.object3D.visible) {
      el.object3D.visible = false;
    }
  }
}

export function restoreClientVideoObjects() {
  for (const el of hiddenEntities) {
    if (el.object3D) {
      el.object3D.visible = true;
    }
  }
  hiddenEntities.length = 0;
}
