import { CAMERA_MODE_TOP_DOWN } from "../systems/camera-system";

// Seen from straight overhead only this box's 0.3m footprint can be aimed at,
// which is a dozen or so pixels once the view is zoomed out — too little to
// point at someone to open their menu. Widen it in 2D (the height does not
// matter from above) to roughly the width of the avatar you can actually see.
const TOP_DOWN_WIDENING = 2;

AFRAME.registerComponent("avatar-inspect-collider", {
  init() {
    this.onTopDownModeChanged = this.onTopDownModeChanged.bind(this);
  },

  play() {
    this.el.setObject3D(
      "avatar-inspect-collider",
      new THREE.Mesh(
        new THREE.BoxGeometry(0.3, 0.8, 0.3),
        new THREE.MeshBasicMaterial({
          visible: false
        })
      )
    );

    this.el.sceneEl.addEventListener("top_down_mode_changed", this.onTopDownModeChanged);
    // Avatars also arrive while the 2D view is already on.
    const hubsSystems = this.el.sceneEl.systems["hubs-systems"];
    this.applyWidening(!!hubsSystems && hubsSystems.cameraSystem.mode === CAMERA_MODE_TOP_DOWN);
  },

  pause() {
    this.el.sceneEl.removeEventListener("top_down_mode_changed", this.onTopDownModeChanged);
  },

  onTopDownModeChanged({ detail: { active } }) {
    this.applyWidening(active);
  },

  applyWidening(topDown) {
    const widening = topDown ? TOP_DOWN_WIDENING : 1;
    this.el.object3D.scale.set(widening, 1, widening);
    this.el.object3D.matrixNeedsUpdate = true;
  }
});
