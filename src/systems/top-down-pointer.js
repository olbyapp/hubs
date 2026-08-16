import { paths } from "./userinput/paths";
import { anyEntityWith } from "../utils/bit-utils";
import { HoveredRemoteRight } from "../bit-components";

// Pointer locomotion for the top-down view: hold the left button to walk toward
// the cursor, double-click to jump there. The regular teleporter is suppressed
// in this mode (see components/teleporter.js) because its aiming arc is
// unreadable from straight overhead.

const DOUBLE_CLICK_MS = 350;
// Stop short of the cursor so holding the button over your own feet does not
// make the avatar jitter around the target.
const ARRIVE_DISTANCE = 0.4;

const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const target = new THREE.Vector3();
const avatarPosition = new THREE.Vector3();
const towardsTarget = new THREE.Vector3();

let wasPressed = false;
let walking = false;
let lastPressTime = 0;

function findGroundTarget(scene, pose, feetY) {
  raycaster.ray.origin.copy(pose.position);
  raycaster.ray.direction.copy(pose.direction);

  // Prefer the nav mesh so the destination is somewhere we can actually stand.
  // It is kept invisible, and raycasting skips invisible objects.
  const navMesh = scene.systems.nav && scene.systems.nav.mesh;
  if (navMesh) {
    const wasVisible = navMesh.visible;
    navMesh.visible = true;
    const hits = raycaster.intersectObject(navMesh, true);
    navMesh.visible = wasVisible;
    if (hits.length) {
      target.copy(hits[0].point);
      return true;
    }
  }

  // Off the nav mesh (or no nav mesh at all): fall back to the floor plane the
  // avatar is standing on, and let the character controller clamp the walk.
  groundPlane.constant = -feetY;
  return !!raycaster.ray.intersectPlane(groundPlane, target);
}

export function tickTopDownPointer(scene, characterController, avatarRig, t) {
  const userinput = scene.systems.userinput;
  if (!userinput) return;

  const pressed = !!userinput.get(paths.device.mouse.buttonLeft);
  const justPressed = pressed && !wasPressed;
  const justReleased = !pressed && wasPressed;
  wasPressed = pressed;

  if (justReleased) {
    walking = false;
  }

  if (justPressed) {
    // Clicks meant for an object or a button belong to the normal cursor path.
    const overSomething =
      !!anyEntityWith(APP.world, HoveredRemoteRight) || scene.systems.interaction.isHoldingAnything();
    walking = !overSomething;
    if (walking) {
      const isDoubleClick = t - lastPressTime < DOUBLE_CLICK_MS;
      lastPressTime = t;
      if (isDoubleClick) {
        walking = false;
        avatarRig.object3D.updateMatrices();
        const pose = userinput.get(paths.device.smartMouse.cursorPose);
        if (pose && findGroundTarget(scene, pose, avatarRig.object3D.matrixWorld.elements[13])) {
          characterController.teleportTo(target);
        }
        return;
      }
    }
  }

  if (!walking) return;

  const pose = userinput.get(paths.device.smartMouse.cursorPose);
  if (!pose) return;

  avatarRig.object3D.updateMatrices();
  avatarPosition.setFromMatrixPosition(avatarRig.object3D.matrixWorld);
  if (!findGroundTarget(scene, pose, avatarPosition.y)) return;

  towardsTarget.subVectors(target, avatarPosition);
  towardsTarget.y = 0;
  if (towardsTarget.lengthSq() < ARRIVE_DISTANCE * ARRIVE_DISTANCE) return;

  // Movement in top-down is read in world axes, so a world-space unit vector is
  // exactly what the character controller expects here.
  towardsTarget.normalize();
  characterController.enqueueRelativeMotion(towardsTarget);
}

export function resetTopDownPointer() {
  wasPressed = false;
  walking = false;
}
