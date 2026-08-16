// Scenes have no dedicated "ceiling" node, so top-down mode hides every
// environment mesh sitting entirely above a height threshold (avatar feet +
// ~one storey). Runs once per toggle, not per frame.

const hiddenMeshes = [];
const box = new THREE.Box3();

// Bounding boxes are derived from geometry + matrixWorld rather than
// Box3.setFromObject because Hubs defers matrix updates (matrixNeedsUpdate),
// so a plain setFromObject can read stale world matrices.
function worldBoxOf(mesh) {
  if (!mesh.geometry) return null;
  mesh.updateMatrices();
  if (!mesh.geometry.boundingBox) {
    mesh.geometry.computeBoundingBox();
  }
  if (!mesh.geometry.boundingBox) return null;
  return box.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
}

export function hideCeilingMeshes(thresholdY) {
  restoreCeilingMeshes();
  const environmentScene = document.querySelector("#environment-scene");
  if (!environmentScene) return;
  environmentScene.object3D.traverse(o => {
    // o.visible is the mesh's own flag, so a mesh nested under one hidden
    // earlier in this traversal is still recorded and restored correctly.
    if (!o.isMesh || !o.visible) return;
    const worldBox = worldBoxOf(o);
    if (!worldBox || worldBox.isEmpty()) return;
    if (worldBox.min.y > thresholdY) {
      o.visible = false;
      hiddenMeshes.push(o);
    }
  });
}

export function restoreCeilingMeshes() {
  for (const mesh of hiddenMeshes) {
    mesh.visible = true;
  }
  hiddenMeshes.length = 0;
}