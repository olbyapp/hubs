/**
 * Ring another user from the avatar hover (freeze) menu.
 * @component call-button
 */
AFRAME.registerComponent("call-button", {
  init() {
    this.onClick = () => {
      if (this.owner) {
        this.el.sceneEl.emit("action_call_client", { clientId: this.owner });
      }
    };
    NAF.utils.getNetworkedEntity(this.el).then(networkedEl => {
      this.owner = networkedEl.components.networked.data.owner;
    });
  },

  play() {
    this.el.object3D.addEventListener("interact", this.onClick);
  },

  pause() {
    this.el.object3D.removeEventListener("interact", this.onClick);
  }
});
