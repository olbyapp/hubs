import { forEachMaterial } from "./material-utils";

// Scenes have no dedicated "ceiling" node, so top-down mode cuts the room open
// with a horizontal clipping plane, like an architectural section: everything
// above the plane stops rendering.
//
// This is applied per material (renderer.localClippingEnabled + material
// .clippingPlanes) rather than by hiding meshes, because:
//  - it also opens rooms whose ceiling is merged into one mesh with the walls,
//    which mesh-level hiding cannot do;
//  - it needs no bounding boxes, so it cannot be defeated by Hubs' deferred
//    matrix updates;
//  - only environment materials are touched, so avatars, name tags and media
//    stay visible even when they sit above the cut.

// Plane keeps the half-space y <= constant (normal points down).
const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
const clipPlanes = [clipPlane];

// The cut used to sit a fixed 3m above the avatar's feet. Since the plane keeps
// what is BELOW it, that quietly did nothing in a room whose ceiling is lower
// than 3m: the ceiling stayed and 2D looked straight at it. Every metre of the
// threshold therefore has to be below the real ceiling — so look up from the
// avatar and put the plane just under whatever is overhead.
//
// The ray starts above head height, which ignores desks and shelves for free,
// and searches far enough up to find the ceiling of a hall rather than settling
// for a conservative slice. When it finds nothing (open sky, or a ceiling whose
// faces point away from the room and so are invisible to a ray) the fallback has
// to be low enough to clear any real ceiling — cutting a bit more wall than
// necessary costs a top-down view nothing, leaving the ceiling on ruins it.
const CUT_MIN_OFFSET = 2;
const CUT_SEARCH_DISTANCE = 8;
const CUT_CLEARANCE = 0.05;

const UP = new THREE.Vector3(0, 1, 0);
const ceilingRaycaster = new THREE.Raycaster();
const rayOrigin = new THREE.Vector3();

export function findCeilingCutY(feetPosition) {
  const environmentScene = document.querySelector("#environment-scene");
  rayOrigin.set(feetPosition.x, feetPosition.y + CUT_MIN_OFFSET, feetPosition.z);
  if (!environmentScene) return rayOrigin.y;

  ceilingRaycaster.set(rayOrigin, UP);
  ceilingRaycaster.far = CUT_SEARCH_DISTANCE;
  const overhead = ceilingRaycaster.intersectObject(environmentScene.object3D, true)[0];
  if (!overhead) return rayOrigin.y;

  return Math.max(rayOrigin.y, rayOrigin.y + overhead.distance - CUT_CLEARANCE);
}

// material -> the clippingPlanes it had before we touched it.
const patchedMaterials = new Map();

function getRenderer() {
  const scene = AFRAME.scenes[0];
  return scene && scene.renderer;
}

function patchMaterial(material) {
  if (patchedMaterials.has(material)) return;
  patchedMaterials.set(material, material.clippingPlanes);
  material.clippingPlanes = clipPlanes;
  material.needsUpdate = true;
}

// Applies the cut to every environment material, including any that appeared
// since the last call (media loaded into the scene, a swapped scene).
export function applyCeilingCut(thresholdY) {
  const renderer = getRenderer();
  if (!renderer) return;
  renderer.localClippingEnabled = true;
  clipPlane.constant = thresholdY;

  const environmentScene = document.querySelector("#environment-scene");
  if (!environmentScene) return;
  environmentScene.object3D.traverse(o => {
    if (o.isMesh) {
      forEachMaterial(o, patchMaterial);
    }
  });
}

export function removeCeilingCut() {
  for (const [material, previousPlanes] of patchedMaterials) {
    material.clippingPlanes = previousPlanes;
    material.needsUpdate = true;
  }
  patchedMaterials.clear();
  const renderer = getRenderer();
  if (renderer) {
    renderer.localClippingEnabled = false;
  }
}
