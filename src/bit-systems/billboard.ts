import { defineQuery } from "bitecs";
import { Box3, Euler, Frustum, Matrix4, Quaternion, Vector3, Object3D, Camera, Mesh } from "three";
import { HubsWorld } from "../app";
import { Billboard } from "../bit-components";
import { setMatrixWorld } from "../utils/three-utils";
import { TOP_DOWN_MENU_READING_DISTANCE } from "../utils/top-down-mode";

const billboardQuery = defineQuery([Billboard]);

const isThisMobileVR = AFRAME.utils.device.isMobileVR();

const targetPos = new Vector3();
const worldPos = new Vector3();
const frustum = new Frustum();
const frustumMatrix = new Matrix4();
const box = new Box3();
const boxTemp = new Box3();

const expandBox = (child: Mesh) => {
  if (child.geometry) {
    child.updateMatrices();
    child.geometry.computeBoundingBox();
    boxTemp.copy(child.geometry.boundingBox!).applyMatrix4(child.matrixWorld);
    box.expandByPoint(boxTemp.min);
    box.expandByPoint(boxTemp.max);
  }
};

const isInViewOfCamera = (object3D: Object3D, camera: Camera) => {
  frustumMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(frustumMatrix);
  box.makeEmpty();
  object3D.traverse(expandBox);

  // NOTE: not using box.setFromObject here because text nodes do not have Z values in their geometry buffer,
  // and that routine ultimately assumes they do.
  return frustum.intersectsBox(box);
};

const shouldUpdateBillboard = (world: HubsWorld, billboard: number, camera: Camera): boolean => {
  const object3D = world.eid2obj.get(billboard)!;
  if (!object3D.visible) {
    return false;
  }

  const inVR = APP.scene?.is("vr-mode");
  return inVR || isInViewOfCamera(object3D, camera);
};

// World orientation for onlyY billboards in top-down mode: face up, text top
// pointing "north" (world -Z), which is screen-up for the fixed top-down camera.
const FACE_UP_QUAT = new Quaternion().setFromEuler(new Euler(-Math.PI / 2, 0, 0));
const parentQuat = new Quaternion();

// A menu scaled for reading from overhead is taller than the avatar it belongs
// to, so it is hung "south" of them (screen-down): that keeps it clear of the
// name tag, which sits north of the head, and keeps its buttons — one of which
// blocks the person — out from under a cursor that is only pointing at them.
const TOP_DOWN_MENU_SOUTH_OFFSET = 0.6;
const menuMatrix = new Matrix4();
const menuPos = new Vector3();
const menuScale = new Vector3();

// In-world menus are authored in metres for someone standing next to them, so
// from a camera 10-25m up they are a few unreadable pixels. Opt in here and the
// whole menu is laid flat and blown up around its owner, keeping every button
// where it was relative to them. See utils/top-down-mode for the scale.
export function readsFromTopDownCamera(object3D: Object3D) {
  object3D.userData.readsFromTopDownCamera = true;
}

const applyTopDownReadingTransform = (object3D: Object3D, topDownHeight: number) => {
  const parent = object3D.parent;
  if (!parent) return;
  if (!object3D.userData.topDownSavedLocalTransform) {
    object3D.userData.topDownSavedLocalTransform = {
      position: object3D.position.clone(),
      scale: object3D.scale.clone()
    };
  }
  // Taken from the parent rather than from this object's own world matrix: that
  // matrix already carries last frame's offset, which would compound every frame.
  parent.updateMatrices();
  menuPos.setFromMatrixPosition(parent.matrixWorld);
  const scale = topDownHeight / TOP_DOWN_MENU_READING_DISTANCE;
  menuPos.z += TOP_DOWN_MENU_SOUTH_OFFSET * scale;
  menuScale.setScalar(scale);
  menuMatrix.compose(menuPos, FACE_UP_QUAT, menuScale);
  setMatrixWorld(object3D, menuMatrix);
};

// Leaving 2D has to put the local transform back, or the menu keeps the zoom
// scale and the offset it was given up there.
const clearTopDownReadingTransform = (object3D: Object3D) => {
  const saved = object3D.userData.topDownSavedLocalTransform;
  if (!saved) return;
  object3D.position.copy(saved.position);
  object3D.scale.copy(saved.scale);
  object3D.matrixNeedsUpdate = true;
  object3D.userData.topDownSavedLocalTransform = null;
};

const updateBillboard = (
  world: HubsWorld,
  billboard: number,
  camera: Camera,
  topDown: boolean,
  topDownHeight: number
) => {
  const object3D = world.eid2obj.get(billboard)!;

  if (object3D.userData.readsFromTopDownCamera) {
    if (topDown) {
      applyTopDownReadingTransform(object3D, topDownHeight);
      return;
    }
    clearTopDownReadingTransform(object3D);
  }

  // Set the camera world position as the target.
  targetPos.setFromMatrixPosition(camera.matrixWorld);

  // Name tags build their own transform in top-down (orientation, scale and an
  // offset off the head), so this system has to leave them alone there. The
  // check sits before the onlyY branch because that branch never runs for them:
  // `Billboard.onlyY` is only ever written by the new loader's inflator, and the
  // tags come from hub.html, where the A-Frame `billboard` component has no
  // schema and drops the `onlyY: true` it is given. They fall through to the
  // lookAt below, which — running after the component ticks, since A-Frame ticks
  // systems last — is what left every tag turned to face the camera instead of
  // lying flat and readable.
  if (topDown && object3D.userData.ownsTopDownOrientation) return;

  if (Billboard.onlyY[billboard]) {
    if (topDown) {
      // Yaw-only billboards are seen edge-on from above; lay them flat instead.
      if (object3D.parent) {
        object3D.parent.updateMatrices();
        object3D.parent.getWorldQuaternion(parentQuat);
        object3D.quaternion.copy(parentQuat.invert()).multiply(FACE_UP_QUAT);
      } else {
        object3D.quaternion.copy(FACE_UP_QUAT);
      }
      object3D.matrixNeedsUpdate = true;
      return;
    }
    object3D.getWorldPosition(worldPos);
    targetPos.y = worldPos.y;
  }
  object3D.lookAt(targetPos);

  object3D.matrixNeedsUpdate = true;
};

let nextBillboard = 0;

// Billboard component that only updates visible objects and only those in the camera view on mobile VR.
// TODO billboarding assumes a single camera viewpoint but with video-texture-source, mirrors, and camera tools this is no longer valid
export function billboardSystem(world: HubsWorld, camera: Camera, topDown: boolean = false, topDownHeight: number = 0) {
  const billboards = billboardQuery(world);
  if (!billboards.length) return;
  if (isThisMobileVR) {
    if (nextBillboard >= billboards.length) {
      nextBillboard = 0;
    }
    const billboard = billboards[nextBillboard++];
    shouldUpdateBillboard(world, billboard, camera) &&
      updateBillboard(world, billboard, camera, topDown, topDownHeight);
  } else {
    billboards.forEach(billboard => updateBillboard(world, billboard, camera, topDown, topDownHeight));
  }
}
