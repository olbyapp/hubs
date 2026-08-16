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