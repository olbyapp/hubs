import { paths } from "./userinput/paths";
import { SOUND_TELEPORT_END } from "./sound-effects-system";
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
// Same limit the teleporter uses, so you cannot land on a wall or a steep ramp.
const UP = new THREE.Vector3(0, 1, 0);
const MAX_LANDING_ANGLE = 45;

const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const target = new THREE.Vector3();
const avatarPosition = new THREE.Vector3();
const towardsTarget = new THREE.Vector3();

let wasPressed = false;
let walking = false;
let lastPressTime = 0;

function aimAt(pose) {
  raycaster.far = Infinity;
  raycaster.ray.origin.copy(pose.position);
  raycaster.ray.direction.copy(pose.direction);
}

// The nav mesh is kept invisible and raycasting skips invisible objects, hence
// the visibility dance — the same one teleporter.js does.
function raycastNavMesh(scene) {
  const navMesh = scene.systems.nav && scene.systems.nav.mesh;
  if (!navMesh) return null;
  const wasVisible = navMesh.visible;
  navMesh.visible = true;
  const hits = raycaster.intersectObject(navMesh, true);
  navMesh.visible = wasVisible;
  return hits.length ? hits[0] : null;
}

// Teleport destinations must be floor you could have walked to, so this only
// accepts a nav mesh hit on a surface flat enough to stand on. Without the
// check a click on a wall, or on a scene with no nav mesh at all, would drop
// the avatar wherever the ray happened to land.
function findTeleportTarget(scene) {
  const hit = raycastNavMesh(scene);
  if (!hit || !hit.face) return false;
  if (THREE.MathUtils.RAD2DEG * UP.angleTo(hit.face.normal) > MAX_LANDING_ANGLE) return false;
  target.copy(hit.point);
  return true;
}

// Walking is more forgiving: aiming past the floor still gives a direction, and
// the character controller clamps the step to the nav mesh anyway.
function findWalkTarget(scene, feetY) {
  const hit = raycastNavMesh(scene);
  if (hit) {
    target.copy(hit.point);
    return true;
  }
  groundPlane.constant = -feetY;
  return !!raycaster.ray.intersectPlane(groundPlane, target);
}

export function tickTopDownPointer(scene, characterController, avatarRig, t) {
  const userinput = scene.systems.userinput;
  if (!userinput) return;

  const pressed = !!userinput.get(paths.device.mouse.buttonLeft);
  const justPressed = pressed && !wasPressed;
  wasPressed = pressed;

  if (!pressed) {
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
        const pose = userinput.get(paths.device.smartMouse.cursorPose);
        if (pose) {
          aimAt(pose);
          if (findTeleportTarget(scene)) {
            characterController.teleportTo(target);
            scene.systems["hubs-systems"].soundEffectsSystem.playSoundOneShot(SOUND_TELEPORT_END);
          }
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
  aimAt(pose);
  if (!findWalkTarget(scene, avatarPosition.y)) return;

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
