/**
 * Cycles the auto-refresh interval of a pasted web-page widget
 * (media-loader mediaOptions.refreshInterval, seconds; 0 = off).
 * Lives in the link hover menu next to "open link".
 */
const STEPS = [10, 30, 60, 300, 0];

function labelFor(intervalS) {
  if (!intervalS) return "auto: off";
  return intervalS >= 60 ? `auto: ${intervalS / 60}m` : `auto: ${intervalS}s`;
}

function currentInterval(targetEl) {
  const mediaLoader = targetEl.components["media-loader"];
  const mediaOptions = (mediaLoader && mediaLoader.data.mediaOptions) || {};
  return mediaOptions.refreshInterval !== undefined ? mediaOptions.refreshInterval : 30;
}

AFRAME.registerComponent("refresh-rate-button", {
  init() {
    this.label = this.el.querySelector("[text]");

    this.updateLabel = () => {
      if (!this.targetEl || !this.targetEl.components["media-loader"]) return;
      this.label.setAttribute("text", "value", labelFor(currentInterval(this.targetEl)));
    };

    this.onComponentChanged = e => {
      if (e.detail.name === "media-loader") this.updateLabel();
    };

    this.onClick = () => {
      if (!this.targetEl || !this.targetEl.components["media-loader"]) return;
      if (!NAF.utils.isMine(this.targetEl) && !NAF.utils.takeOwnership(this.targetEl)) return;
      const current = currentInterval(this.targetEl);
      const next = STEPS[(STEPS.indexOf(current) + 1) % STEPS.length];
      const mediaOptions = Object.assign({}, this.targetEl.components["media-loader"].data.mediaOptions, {
        refreshInterval: next
      });
      // mediaOptions is part of the networked media-loader schema, so the new
      // interval syncs to every client and persists with pinned objects.
      this.targetEl.setAttribute("media-loader", "mediaOptions", mediaOptions);
      this.updateLabel();
    };

    NAF.utils
      .getNetworkedEntity(this.el)
      .then(networkedEl => {
        this.targetEl = networkedEl;
        this.targetEl.addEventListener("componentchanged", this.onComponentChanged);
        this.updateLabel();
      })
      .catch(() => {});
  },

  remove() {
    if (this.targetEl) this.targetEl.removeEventListener("componentchanged", this.onComponentChanged);
  },

  play() {
    this.el.object3D.addEventListener("interact", this.onClick);
  },

  pause() {
    this.el.object3D.removeEventListener("interact", this.onClick);
  }
});
