import anime from "animejs";
import MovingAverage from "moving-average";
import { getThemeColor } from "../utils/theme";
import qsTruthy from "../utils/qs_truthy";
import { findAncestorWithComponent } from "../utils/scene-graph";
import nextTick from "../utils/next-tick";
import { createPlaneBufferGeometry, setMatrixWorld } from "../utils/three-utils";
import { textureLoader } from "../utils/media-utils";

import handRaisedIconSrc from "../assets/hud/hand-raised.png";
import { STATUS_LABELS, STATUS_COLORS } from "../utils/user-status";
import { getAchievementTexture, getPrivateZoneIconTexture, getStatusIconTexture } from "../utils/status-icons";
import { achievementLine } from "../utils/achievements";
import { isSessionInPrivateZone } from "../utils/private-zone";
import { CAMERA_MODE_TOP_DOWN } from "../systems/camera-system";
import { TOP_DOWN_READING_DISTANCE } from "../utils/top-down-mode";

const DEBUG = qsTruthy("debug");
const NAMETAG_BACKGROUND_PADDING = 0.05;
const NAMETAG_STATUS_BORDER_PADDING = 0.035;
const NAMETAG_MIN_WIDTH = 0.6;
const NAMETAG_HEIGHT = 0.25;
const NAMETAG_TALL_HEIGHT = 0.325;
const NAMETAG_OFFSET = 0.2;
const NAMETAG_TALL_OFFSET = 0.25;
const NAMETAG_VOLUME_Y = -0.075;
const NAMETAG_VOLUME_TALL_Y = -0.12;
const NAMETAG_TEXT_Y = 0.1;
const NAMETAG_TEXT_TALL_Y = 0.125;
const TYPING_ANIM_SPEED = 150;
const DISPLAY_NAME_LENGTH = 18;
const NAMETAG_STATUS_ICON_PADDING = 0.025;
// Height of the weekly award line. A shade taller than the pronouns text it
// replaces, because an emoji at this size needs the room to stay legible.
const ACHIEVEMENT_LINE_HEIGHT = 0.075;
// Award and status share the second line, unless both are there — then the
// status drops below the award.
const NAMETAG_STATUS_BELOW_Y = -0.09;
// Top-down: lie flat, top edge pointing north, matching the fixed camera.
const NAMETAG_FACE_UP = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const NAMETAG_TOP_DOWN_CLEARANCE = 0.2;
const V_ONE = new THREE.Vector3(1, 1, 1);

const ANIM_CONFIG = {
  duration: 400,
  easing: "easeOutQuart",
  elasticity: 400,
  loop: 0,
  round: false
};

const nametagVolumeGeometry = new THREE.PlaneBufferGeometry(1, 0.025);
const nametagVolumeMaterial = new THREE.MeshBasicMaterial({ color: "#7ED320" });

const nametagTypingGeometry = new THREE.CircleBufferGeometry(0.01, 6);

const handRaisedTexture = textureLoader.load(handRaisedIconSrc);
const handRaisedGeometry = createPlaneBufferGeometry(0.2, 0.2, 1, 1, handRaisedTexture.flipY);
const handRaisedMaterial = new THREE.MeshBasicMaterial({ transparent: true, map: handRaisedTexture });

// Unit square, scaled per nametag once the plate height is known.
const statusIconGeometry = createPlaneBufferGeometry(1, 1, 1, 1, true);

AFRAME.registerComponent("name-tag", {
  schema: {},
  init() {
    this.store = window.APP.store;
    this.displayName = null;
    this.achievement = "";
    this.achievementCount = 0;
    this.identityName = null;
    this.status = "none";
    this.isInPrivateZone = false;
    this.isTalking = false;
    this.isTyping = false;
    this.isOwner = false;
    this.isRecording = false;
    this.isHandRaised = false;
    this.volumeAvg = new MovingAverage(128);
    this.shouldBeVisible = true;
    this.size = new THREE.Vector3();
    this.avatarAABB = new THREE.Box3();
    this.avatarAABBSize = new THREE.Vector3();
    this.avatarAABBCenter = new THREE.Vector3();
    this.nametagHeight = 0;
    this.isAvatarReady = false;
    this.lastUpdateTime = Date.now();
    this.nameTagHeight = NAMETAG_HEIGHT;
    this.nameTagOffset = NAMETAG_OFFSET;
    this.nameTagVolumeY = NAMETAG_VOLUME_Y;
    this.nameTagTextY = NAMETAG_TEXT_Y;

    this.onPresenceUpdated = this.onPresenceUpdated.bind(this);
    this.onModelLoading = this.onModelLoading.bind(this);
    this.onModelLoaded = this.onModelLoaded.bind(this);
    this.onModelIkFirstTick = this.onModelIkFirstTick.bind(this);
    this.onStateChanged = this.onStateChanged.bind(this);
    this.updateNametagWidth = this.updateNametagWidth.bind(this);
    this.updateElements = this.updateElements.bind(this);

    this.nametag = this.el.object3D;
    // Tells the billboard system to keep its hands off in top-down: the tick
    // below composes this tag's whole transform there.
    this.nametag.userData.ownsTopDownOrientation = true;
    this.nametagIdentityName = this.el.querySelector(".identityName").object3D;
    this.nametagBackground = this.el.querySelector(".nametag-background").object3D;
    this.nametagStatusBorder = this.el.querySelector(".nametag-status-border").object3D;
    this.recordingBadge = this.el.querySelector(".recordingBadge").object3D;
    this.modBadge = this.el.querySelector(".modBadge").object3D;
    this.nametagText = this.el.querySelector(".nametag-text").object3D;
    this.statusText = this.el.querySelector(".status-text").object3D;

    // Weekly award line, standing where pronouns used to. Painted into a
    // canvas rather than set as MSDF text like the lines around it: the award
    // labels are Cyrillic and carry an emoji, and the nametag font has
    // neither.
    this.achievementWidth = 0;
    this.achievementLabel = new THREE.Mesh(
      statusIconGeometry,
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false })
    );
    this.achievementLabel.visible = false;
    this.el.object3D.add(this.achievementLabel);

    this.handRaised = new THREE.Mesh(handRaisedGeometry, handRaisedMaterial);
    this.handRaised.position.set(0, -0.3, 0.001);
    this.handRaised.matrixNeedsUpdate = true;
    this.el.object3D.add(this.handRaised);

    // Status icon: fills the height of the plate at its right end, with the
    // name and status text shifted into the space that remains on the left.
    this.statusIconSize = 0;
    this.textOffsetX = 0;
    this.statusIcon = new THREE.Mesh(
      statusIconGeometry,
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false })
    );
    this.statusIcon.visible = false;
    this.el.object3D.add(this.statusIcon);

    // Ear icon, to the right of the status icon: says this person is in a
    // private zone, which is otherwise invisible to everyone outside it — they
    // would just seem to have gone quiet.
    this.privateZoneIconSize = 0;
    this.privateZoneIcon = new THREE.Mesh(
      statusIconGeometry,
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false })
    );
    this.privateZoneIcon.visible = false;
    this.el.object3D.add(this.privateZoneIcon);

    this.nametagVolume = new THREE.Mesh(nametagVolumeGeometry, nametagVolumeMaterial);
    this.nametagVolume.position.set(0, this.nameTagVolumeY, 0.001);
    this.nametagVolume.matrixNeedsUpdate = true;
    this.nametagVolume.visible = false;
    this.el.object3D.add(this.nametagVolume);

    // TODO this is horribly inefficient draw call and geometry wise. Replace with custom shader code or at least a uv-croll image
    this.nametagTyping = new THREE.Group();
    this.nametagTyping.position.set(0, this.nameTagVolumeY, 0.001);
    this.nametagTyping.matrixNeedsUpdate = true;
    for (let i = 0; i < 5; i++) {
      const dot = new THREE.Mesh(
        nametagTypingGeometry,
        new THREE.MeshBasicMaterial({ transparent: true, color: 0xffffff, depthWrite: false })
      );
      dot.position.x = i * 0.035 - 0.07;
      this.nametagTyping.add(dot);
    }
    this.el.object3D.add(this.nametagTyping);

    this.updateTheme();

    NAF.utils.getNetworkedEntity(this.el).then(networkedEntity => {
      this.playerSessionId = NAF.utils.getCreator(networkedEntity);
      const playerPresence = window.APP.hubChannel.presence.state[this.playerSessionId];
      if (playerPresence) {
        this.updateFromPresenceMeta(playerPresence.metas[0]);
      }
    });

    if (DEBUG) {
      this.avatarAABBHelper = new THREE.Box3Helper(this.avatarAABB, 0xffff00);
      this.el.sceneEl.object3D.add(this.avatarAABBHelper);
    }

    this.onStateChanged();
  },

  remove() {
    if (DEBUG) this.el.sceneEl.object3D.remove(this.avatarAABBHelper);
  },

  tick: (() => {
    let typingAnimTime = 0;
    const worldPos = new THREE.Vector3();
    const mat = new THREE.Matrix4();
    const topDownScale = new THREE.Vector3();
    const tagQuat = new THREE.Quaternion();
    const ignoredVec = new THREE.Vector3();
    return function (t) {
      if (!this.isAvatarReady) {
        this.nametag.visible = false;
        return;
      }
      this.wasTalking = this.isTalking;
      this.isTalking = this.audioAnalyzer.avatarIsTalking;

      // Membership changes as people walk, with no event to hang this on.
      const inPrivateZone = isSessionInPrivateZone(this.playerSessionId);
      if (inPrivateZone !== this.isInPrivateZone) {
        this.isInPrivateZone = inPrivateZone;
        this.onPrivateZoneChanged();
      }

      if (this.shouldBeVisible) {
        this.nametag.visible = true;
        if (this.isTalking !== this.wasTalking) {
          this.resizeNameTag();
        }
        if (this.isTalking) {
          this.nametagVolume.visible = this.isTalking;
          this.nametagVolume.scale.setX(this.audioAnalyzer.volume * this.size.x);
          this.nametagVolume.matrixNeedsUpdate = true;
          this.nametagTyping.visible = false;
        } else {
          if (this.isTyping) {
            this.nametagTyping.visible = true;
            typingAnimTime = t;
            this.nametagTyping.traverse(o => {
              if (o.material) {
                o.material.opacity = (Math.sin(typingAnimTime / TYPING_ANIM_SPEED) + 1) / 2;
                typingAnimTime -= TYPING_ANIM_SPEED;
              }
            });
          } else {
            this.nametagTyping.visible = false;
          }
        }
        this.nametagStatusBorder.visible = this.isTyping || this.isTalking || this.isHandRaised;
        this.recordingBadge.visible = this.isRecording;
        this.modBadge.visible = this.isOwner && !this.isRecording;
        this.handRaised.visible = this.isHandRaised;

        this.neck.getWorldPosition(worldPos);
        worldPos.setY(this.nametagElPosY + this.ikRoot.position.y);
        const cameraSystem = this.el.sceneEl.systems["hubs-systems"].cameraSystem;
        if (cameraSystem.mode === CAMERA_MODE_TOP_DOWN) {
          // Set the orientation here rather than leaning on the billboard
          // system: copying the current world matrix would inherit the avatar's
          // yaw, which is what left names upside down as people turned around.
          // The scale keeps the tag the same size on screen at any zoom.
          const scale = cameraSystem.topDownHeight / TOP_DOWN_READING_DISTANCE;
          topDownScale.setScalar(scale);
          // A tag this large would blanket the avatar from overhead, so park it
          // north of the head — which reads as just above them on screen.
          worldPos.z -= (this.nameTagHeight / 2 + NAMETAG_TOP_DOWN_CLEARANCE) * scale;
          mat.compose(worldPos, NAMETAG_FACE_UP, topDownScale);
        } else {
          // Take the billboard's rotation but drop everything else: copying the
          // whole matrix carried the top-down zoom scale back into 3D, which is
          // what left every tag giant after a trip through the 2D view.
          this.nametag.matrixWorld.decompose(ignoredVec, tagQuat, ignoredVec);
          mat.compose(worldPos, tagQuat, V_ONE);
        }
        setMatrixWorld(this.nametag, mat);
      } else {
        this.nametag.visible = false;
      }

      if (DEBUG) {
        this.updateAvatarModelAABB();
        this.avatarAABBHelper.matrixNeedsUpdate = true;
        this.avatarAABBHelper.updateMatrixWorld(true);
      }
    };
  })(),

  play() {
    this.el.parentEl.addEventListener("model-loading", this.onModelLoading);
    this.el.parentEl.addEventListener("model-loaded", this.onModelLoaded);
    this.el.parentEl.addEventListener("ik-first-tick", this.onModelIkFirstTick);
    this.el.sceneEl.addEventListener("presence_updated", this.onPresenceUpdated);
    window.APP.store.addEventListener("statechanged", this.onStateChanged);
    this.el.sceneEl.systems["hubs-systems"].nameTagSystem.register(this);
  },

  pause() {
    this.el.parentEl.removeEventListener("model-loading", this.onModelLoading);
    this.el.parentEl.removeEventListener("model-loaded", this.onModelLoaded);
    this.el.parentEl.removeEventListener("ik-first-tick", this.onModelIkFirstTick);
    this.el.sceneEl.removeEventListener("presence_updated", this.onPresenceUpdated);
    window.APP.store.removeEventListener("statechanged", this.onStateChanged);
    this.el.sceneEl.systems["hubs-systems"].nameTagSystem.unregister(this);
  },

  onPresenceUpdated({ detail: presenceMeta }) {
    if (presenceMeta.sessionId === this.playerSessionId) {
      this.updateFromPresenceMeta(presenceMeta);
    }
  },

  updateFromPresenceMeta(presenceMeta) {
    this.displayName = presenceMeta.profile.displayName;
    // Awarded weekly by hub-stats, written into the profile by whoever won it
    // and carried to everyone by presence, exactly the way status is.
    this.achievement = presenceMeta.profile.achievement || "";
    this.achievementCount = presenceMeta.profile.achievementCount || 0;
    this.identityName = presenceMeta.profile.identityName;
    // Everyone carries a status now, including those who never opened the
    // picker, so the plate always has a label and an icon.
    this.status = presenceMeta.profile.status || "none";
    this.isRecording = !!(presenceMeta.streaming || presenceMeta.recording);
    this.isOwner = !!(presenceMeta.roles && presenceMeta.roles.owner);
    this.isTyping = !!presenceMeta.typing;
    this.isHandRaised = !!presenceMeta.hand_raised;
    if (this.isAvatarReady) {
      this.updateElements();
    }
  },

  updateNametagWidth() {
    this.statusText.el.components["text"].getSize(this.size);
    const statusTextSize = this.size.x || 0;
    this.nametagText.el.components["text"].getSize(this.size);
    this.size.x = Math.max(this.size.x, this.achievementWidth, statusTextSize, NAMETAG_MIN_WIDTH);
    this.resizeNameTag();
  },

  updateDisplayName() {
    if (this.displayName && this.displayName !== this.prevDisplayName) {
      this.nametagText.el.addEventListener("text-updated", () => this.updateNametagWidth(), {
        once: true
      });
      if (this.displayName.length > DISPLAY_NAME_LENGTH) {
        this.displayName = this.displayName.slice(0, DISPLAY_NAME_LENGTH).concat("...");
      }
      this.nametagText.el.setAttribute("text", {
        value: this.displayName
      });
      this.prevDisplayName = this.displayName;
    }

    if (this.identityName) {
      if (this.identityName.length > DISPLAY_NAME_LENGTH) {
        this.identityName = this.identityName.slice(0, DISPLAY_NAME_LENGTH).concat("...");
      }
      this.nametagIdentityName.el.setAttribute("text", { value: this.identityName });
    }

    this.nametagText.position.set(this.textOffsetX, this.nameTagTextY, 0.001);
    this.nametagText.matrixNeedsUpdate = true;
  },

  updateStatus() {
    const label = (this.status && STATUS_LABELS[this.status]) || "";
    if (label !== this.prevStatusLabel) {
      this.statusText.el.addEventListener("text-updated", () => this.updateNametagWidth(), {
        once: true
      });
      this.statusText.el.setAttribute("text", {
        value: label,
        color: STATUS_COLORS[this.status] || STATUS_COLORS.none
      });
      this.prevStatusLabel = label;
    }
    this.statusText.position.set(this.textOffsetX, this.achievement ? NAMETAG_STATUS_BELOW_Y : 0, 0.001);
    this.statusText.matrixNeedsUpdate = true;

    const texture = getStatusIconTexture(this.status);
    this.statusIcon.visible = !!texture;
    if (texture) {
      this.statusIcon.material.map = texture;
      this.statusIcon.material.needsUpdate = true;
      this.statusIcon.scale.setScalar(this.statusIconSize);
      this.statusIcon.matrixNeedsUpdate = true;
    }
  },

  updateAchievement() {
    const line = achievementLine(this.achievement, this.achievementCount);
    if (line !== this.prevAchievementLine) {
      const label = getAchievementTexture(line);
      this.achievementLabel.visible = !!label;
      this.achievementWidth = label ? ACHIEVEMENT_LINE_HEIGHT * label.aspect : 0;
      if (label) {
        this.achievementLabel.material.map = label.texture;
        this.achievementLabel.material.needsUpdate = true;
        this.achievementLabel.scale.set(this.achievementWidth, ACHIEVEMENT_LINE_HEIGHT, 1);
      }
      this.prevAchievementLine = line;
      // The canvas is measured as it is drawn, so unlike the MSDF lines around
      // it there is no text-updated event to wait for before the plate can be
      // sized to fit.
      this.updateNametagWidth();
    }
    this.achievementLabel.position.set(this.textOffsetX, 0, 0.001);
    this.achievementLabel.matrixNeedsUpdate = true;
  },

  onModelLoading() {
    this.model = null;
    this.isAvatarReady = false;
  },

  onModelLoaded({ detail: { model } }) {
    this.model = model;
  },

  async onModelIkFirstTick() {
    await nextTick();
    this.ikRoot = findAncestorWithComponent(this.el, "ik-root").object3D;
    this.neck = this.ikRoot.el.querySelector(".Neck").object3D;
    this.audioAnalyzer = this.ikRoot.el.querySelector(".AvatarRoot").components["networked-audio-analyser"];

    this.updateElements();
    this.isAvatarReady = true;
  },

  updateElements() {
    if (this.achievement || (this.status && STATUS_LABELS[this.status])) {
      this.nameTagHeight = NAMETAG_TALL_HEIGHT;
      this.nameTagOffset = NAMETAG_TALL_OFFSET;
      this.nameTagVolumeY = NAMETAG_VOLUME_TALL_Y;
      this.nameTagTextY = NAMETAG_TEXT_TALL_Y;
    } else {
      this.nameTagHeight = NAMETAG_HEIGHT;
      this.nameTagOffset = NAMETAG_OFFSET;
      this.nameTagVolumeY = NAMETAG_VOLUME_Y;
      this.nameTagTextY = NAMETAG_TEXT_Y;
    }

    // Work out the icons and the room they take from the text before laying out.
    this.applyIconLayout();

    this.updateAvatarModelAABB();
    const tmpVector = new THREE.Vector3();
    this.nametagHeight =
      Math.abs(tmpVector.subVectors(this.ikRoot.position, this.avatarAABBCenter).y) +
      this.avatarAABBSize.y / 2 +
      this.nameTagOffset;
    this.nametagElPosY = this.nametagHeight + (this.isHandRaised ? this.nameTagOffset : 0);
    this.statusText.el && this.statusText.el.components["text"].getSize(this.size);
    const statusTextSize = this.size.x;
    this.nametagText.el.components["text"].getSize(this.size);
    this.size.x = Math.max(this.size.x, this.achievementWidth, statusTextSize, NAMETAG_MIN_WIDTH);
    this.nametagVolume.position.set(0, this.nameTagVolumeY, 0.001);
    this.nametagVolume.matrixNeedsUpdate = true;
    this.nametagTyping.position.set(0, this.nameTagVolumeY, 0.001);
    this.nametagTyping.matrixNeedsUpdate = true;

    this.updateDisplayName();
    this.updateAchievement();
    this.updateStatus();
    this.updateHandRaised();
    this.resizeNameTag();
  },

  updateTheme() {
    this.nametagStatusBorder.el.setAttribute(
      "slice9",
      "color",
      getThemeColor(this.isHandRaised ? "nametag-border-color-raised-hand" : "nametag-border-color")
    );
    nametagVolumeMaterial.color.set(getThemeColor("nametag-volume-color"));
    this.nametagBackground.el.setAttribute("slice9", "color", getThemeColor("nametag-color"));
    this.nametagText.el.setAttribute("text", "color", getThemeColor("nametag-text-color"));
  },

  onStateChanged() {
    this.updateTheme();
  },

  // Both icons stand at the right end of the plate, filling its height, and the
  // text is shifted left by half of what they take. Kept apart from
  // updateElements so a private zone opening or closing does not re-run the
  // hand-raised animation with it.
  applyIconLayout() {
    const iconSize = this.nameTagHeight - NAMETAG_STATUS_ICON_PADDING * 2;
    this.statusIconSize = getStatusIconTexture(this.status) ? iconSize : 0;
    this.privateZoneIconSize = this.isInPrivateZone ? iconSize : 0;
    this.textOffsetX = -(this.statusIconSize + this.privateZoneIconSize) / 2;

    const texture = this.privateZoneIconSize ? getPrivateZoneIconTexture() : null;
    this.privateZoneIcon.visible = !!texture;
    if (texture) {
      this.privateZoneIcon.material.map = texture;
      this.privateZoneIcon.material.needsUpdate = true;
      this.privateZoneIcon.scale.setScalar(this.privateZoneIconSize);
      this.privateZoneIcon.matrixNeedsUpdate = true;
    }
  },

  // Laid out right to left: the ear sits outermost, the status icon beside it.
  onPrivateZoneChanged() {
    this.applyIconLayout();
    this.updateDisplayName();
    this.updateStatus();
    this.resizeNameTag();
  },

  resizeNameTag() {
    const width = this.size.x + NAMETAG_BACKGROUND_PADDING * 2 + this.statusIconSize + this.privateZoneIconSize;
    this.nametagBackground.el.setAttribute("slice9", {
      width,
      height: this.nameTagHeight
    });
    this.nametagStatusBorder.el.setAttribute("slice9", {
      width: width + NAMETAG_STATUS_BORDER_PADDING,
      height: this.nameTagHeight + NAMETAG_STATUS_BORDER_PADDING
    });
    let iconRight = width / 2 - NAMETAG_STATUS_ICON_PADDING;
    if (this.privateZoneIconSize) {
      this.privateZoneIcon.position.set(iconRight - this.privateZoneIconSize / 2, 0, 0.002);
      this.privateZoneIcon.matrixNeedsUpdate = true;
      iconRight -= this.privateZoneIconSize;
    }
    if (this.statusIconSize) {
      this.statusIcon.position.set(iconRight - this.statusIconSize / 2, 0, 0.002);
      this.statusIcon.matrixNeedsUpdate = true;
    }
  },

  updateHandRaised() {
    this.nametagStatusBorder.el.setAttribute(
      "slice9",
      "color",
      getThemeColor(this.isHandRaised ? "nametag-border-color-raised-hand" : "nametag-border-color")
    );
    const targetScale = this.isHandRaised ? 1 : 0;
    anime({
      ...ANIM_CONFIG,
      targets: {
        x: this.handRaised.scale.x,
        y: this.handRaised.scale.y,
        z: this.handRaised.scale.z
      },
      x: targetScale,
      y: targetScale,
      z: targetScale,
      update: anim => {
        this.handRaised.scale.set(
          anim.animatables[0].target.x,
          anim.animatables[0].target.y,
          anim.animatables[0].target.z
        );
        this.handRaised.matrixNeedsUpdate = true;
      }
    });
    anime({
      ...ANIM_CONFIG,
      targets: {
        y: this.nametagElPosY
      },
      y: this.nametagHeight + (this.isHandRaised ? this.nameTagOffset : 0),
      update: anim => {
        this.nametagElPosY = anim.animatables[0].target.y;
      }
    });
  },

  updateAvatarModelAABB() {
    if (!this.model) return;
    this.avatarAABB.setFromObject(this.model);
    this.avatarAABB.getSize(this.avatarAABBSize);
    this.avatarAABB.getCenter(this.avatarAABBCenter);
  }
});
