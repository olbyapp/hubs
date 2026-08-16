import { defineQuery } from "bitecs";
import { Box3, Euler, Frustum, Matrix4, Quaternion, Vector3, Object3D, Camera, Mesh } from "three";
import { HubsWorld } from "../app";
import { Billboard } from "../bit-components";

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

const updateBillboard = (world: HubsWorld, billboard: number, camera: Camera, topDown: boolean) => {
  const object3D = world.eid2obj.get(billboard)!;
  // Set the camera world position as the target.
  targetPos.setFromMatrixPosition(camera.matrixWorld);

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
export function billboardSystem(world: HubsWorld, camera: Camera, topDown: boolean = false) {
  const billboards = billboardQuery(world);
  if (!billboards.length) return;
  if (isThisMobileVR) {
    if (nextBillboard >= billboards.length) {
      nextBillboard = 0;
    }
    const billboard = billboards[nextBillboard++];
    shouldUpdateBillboard(world, billboard, camera) && updateBillboard(world, billboard, camera, topDown);
  } else {
    billboards.forEach(billboard => updateBillboard(world, billboard, camera, topDown));
  }
}
