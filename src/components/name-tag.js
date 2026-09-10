import anime from "animejs";
import MovingAverage from "moving-average";
import { getThemeColor } from "../utils/theme";
import qsTruthy from "../utils/qs_truthy";
import { findAncestorWithComponent } from "../utils/scene-graph";
import nextTick from "../utils/next-tick";
import { createPlaneBufferGeometry, setMatrixWorld } from "../utils/three-utils";
import { textureLoader } from "../utils/media-utils";

import handRaisedIconSrc from "../assets/hud/hand-raised.png";
import { STATUS_COLORS, statusLabelFor } from "../utils/user-status";
import {
  createStatusTextTexture,
  getAchievementIconsTexture,
  getAwayIconTexture,
  getPrivateZoneIconTexture,
  getStatusIconTexture
} from "../utils/status-icons";
import { achievementEmoji } from "../utils/achievements";
import { isSessionInPrivateZone } from "../utils/private-zone";
import { CAMERA_MODE_TOP_DOWN } from "../systems/camera-system";
import { TOP_DOWN_READING_DISTANCE } from "../utils/top-down-mode";

const DEBUG = qsTruthy("debug");
const NAMETAG_BACKGROUND_PADDING = 0.05;
const NAMETAG_STATUS_BORDER_PADDING = 0.035;
const NAMETAG_MIN_WIDTH = 0.6;
const NAMETAG_HEIGHT = 0.25;
const NAMETAG_OFFSET = 0.2;
const NAMETAG_VOLUME_Y = -0.075;
const NAMETAG_TEXT_Y = 0.1;
const TYPING_ANIM_SPEED = 150;
const DISPLAY_NAME_LENGTH = 18;
const NAMETAG_STATUS_ICON_PADDING = 0.025;
// The away mark is a fraction of a badge: it goes next to the name, not among them.
const NAMETAG_AWAY_ICON_SCALE = 0.55;
// Awards are drawn as icons only — no label. A name reads at a glance and a
// row of glyphs under it does too; a Cyrillic award name at this size did not,
// and it collided with the name above it.
const ACHIEVEMENT_ICON_HEIGHT = 0.115;

// A custom status takes the same row as a fixed one, but is painted from a
// canvas rather than set as MSDF text, so its size is given here instead of in
// hub.html. Chosen to put the letters at about the 0.065 the MSDF status line
// uses, allowing for the ascender and descender room the canvas box reserves.
const CUSTOM_STATUS_TEXT_HEIGHT = 0.075;
// A custom status may run to a hundred characters. The plate is exactly as wide
// as the widest thing on it, and a hundred characters of plate floating over
// somebody's head would blot out the room, so the tag shows an opening and the
// People panel carries the whole of it.
const NAMETAG_STATUS_TEXT_LENGTH = 28;

function truncateStatusText(text) {
  const characters = Array.from(text);
  if (characters.length <= NAMETAG_STATUS_TEXT_LENGTH) return text;
  return `${characters.slice(0, NAMETAG_STATUS_TEXT_LENGTH).join("")}…`;
}

// The plate grows a line at a time. Three rows (name, awards, status) need
// more room than the two the pronouns line ever asked for, so each layout is
// spelled out rather than derived from a single "tall" flag.
//
// The numbers were dialled in against the running client rather than derived:
// MSDF text, an emoji canvas and a slice9 panel each carry their own idea of
// where their vertical centre is, and the arithmetic that says these rows are
// evenly spaced does not match what the eye sees.
const NAMETAG_LAYOUTS = {
  // rows below the name -> plate height, plate offset above the head, and the
  // y of the name, first row and second row.
  0: { height: NAMETAG_HEIGHT, offset: NAMETAG_OFFSET, nameY: NAMETAG_TEXT_Y, firstY: 0, secondY: 0 },
  1: { height: 0.34, offset: 0.25, nameY: 0.13, firstY: -0.035, secondY: 0 },
  2: { height: 0.42, offset: 0.3, nameY: 0.18, firstY: -0.02, secondY: -0.12 }
};
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
    // The words behind status "custom". Named apart from this.statusText, which
    // is the MSDF object3D that draws the fixed statuses.
    this.customStatus = "";
    this.customStatusWidth = 0;
    this.customStatusTexture = null;
    this.prevCustomStatus = "";
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
    this.nameTagWidth = NAMETAG_MIN_WIDTH;
    this.nameTagOffset = NAMETAG_OFFSET;
    // Filled in by the top-down branch of the tick and read by the layout pass
    // in name-tag-visibility-system, which hands back topDownStackOffset: how
    // far north this plate has to move to stay off the ones around it.
    this.topDownPreferred = new THREE.Vector3();
    this.topDownHalfWidth = 0;
    this.topDownHalfDepth = 0;
    this.topDownStackOffset = 0;
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

    // Weekly awards, standing where pronouns used to: one canvas strip of
    // emoji, no text. MSDF has no emoji glyphs, and the labels are Cyrillic,
    // so this could never have been ordinary nametag text.
    this.achievementWidth = 0;
    this.achievementLabel = new THREE.Mesh(
      statusIconGeometry,
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false })
    );
    this.achievementLabel.visible = false;
    this.el.object3D.add(this.achievementLabel);

    // The custom-status line, sharing the status row with the MSDF one — only
    // ever one of the two is visible. Same reason as the awards above it: the
    // nametag font is MSDF, and a status somebody typed will have Cyrillic or
    // an emoji in it sooner rather than later.
    this.customStatusLabel = new THREE.Mesh(
      statusIconGeometry,
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false })
    );
    this.customStatusLabel.visible = false;
    this.el.object3D.add(this.customStatusLabel);

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

    // Eye icon: this person's tab is in the background, so they are not looking at
    // the room. Worth showing - otherwise they read as present but unresponsive.
    this.isPageHidden = false;
    this.awayIconSize = 0;
    this.awayIconHeight = 0;
    this.awayIcon = new THREE.Mesh(
      statusIconGeometry,
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false })
    );
    this.awayIcon.visible = false;
    this.el.object3D.add(this.awayIcon);

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
    // Painted for this tag alone and shared with nothing, so it goes with it.
    if (this.customStatusTexture) this.customStatusTexture.dispose();
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
          // Where this plate would go if it were the only one, and how big it
          // is once blown up. The layout pass works from these, and never from
          // where the tag ended up, so its own nudge cannot feed back into the
          // next frame's placement.
          this.topDownPreferred.copy(worldPos);
          this.topDownHalfWidth = (this.nameTagWidth * scale) / 2;
          this.topDownHalfDepth = (this.nameTagHeight * scale) / 2;
          worldPos.z -= this.topDownStackOffset;
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
    this.customStatus = presenceMeta.profile.statusText || "";
    this.isPageHidden = !!presenceMeta.profile.hidden;
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
    this.size.x = Math.max(
      this.size.x,
      this.achievementWidth,
      statusTextSize,
      this.customStatusWidth,
      NAMETAG_MIN_WIDTH
    );
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

  // A custom status with nothing readable behind it is not a status: no line,
  // no badge. setOwnStatus refuses to publish one, but the text arrives over
  // presence and any client can put anything in a profile.
  statusIconTexture() {
    if (this.status === "custom" && !this.statusLabel()) return null;
    return getStatusIconTexture(this.status);
  },

  statusLabel() {
    return statusLabelFor(this.status, this.customStatus);
  },

  updateStatus() {
    // The two lines share the row and take it in turns: MSDF for the fixed
    // statuses it can spell, canvas for the one it cannot.
    const isCustom = this.status === "custom";
    const label = isCustom ? "" : this.statusLabel();
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
    this.statusText.position.set(this.textOffsetX, this.statusRowY, 0.001);
    this.statusText.matrixNeedsUpdate = true;

    const custom = isCustom ? truncateStatusText(this.statusLabel()) : "";
    if (custom !== this.prevCustomStatus) {
      // Each tag owns its texture rather than sharing a cached one, so the old
      // one has nobody else drawing with it once it is replaced.
      if (this.customStatusTexture) this.customStatusTexture.dispose();
      const painted = createStatusTextTexture(custom, STATUS_COLORS.custom);
      this.customStatusTexture = painted && painted.texture;
      this.customStatusLabel.visible = !!painted;
      this.customStatusWidth = painted ? CUSTOM_STATUS_TEXT_HEIGHT * painted.aspect : 0;
      if (painted) {
        this.customStatusLabel.material.map = painted.texture;
        this.customStatusLabel.material.needsUpdate = true;
        this.customStatusLabel.scale.set(this.customStatusWidth, CUSTOM_STATUS_TEXT_HEIGHT, 1);
      }
      this.prevCustomStatus = custom;
      // Measured as it is painted, so unlike the MSDF line beside it there is
      // no text-updated event to wait for before the plate can be sized to fit.
      this.updateNametagWidth();
    }
    this.customStatusLabel.position.set(this.textOffsetX, this.statusRowY, 0.001);
    this.customStatusLabel.matrixNeedsUpdate = true;

    const texture = this.statusIconTexture();
    this.statusIcon.visible = !!texture;
    if (texture) {
      this.statusIcon.material.map = texture;
      this.statusIcon.material.needsUpdate = true;
      this.statusIcon.scale.setScalar(this.statusIconSize);
      this.statusIcon.matrixNeedsUpdate = true;
    }
  },

  updateAchievement() {
    const emoji = achievementEmoji(this.achievement);
    const key = emoji.join("");
    if (key !== this.prevAchievementKey) {
      const icons = getAchievementIconsTexture(emoji);
      this.achievementLabel.visible = !!icons;
      this.achievementWidth = icons ? ACHIEVEMENT_ICON_HEIGHT * icons.aspect : 0;
      if (icons) {
        this.achievementLabel.material.map = icons.texture;
        this.achievementLabel.material.needsUpdate = true;
        this.achievementLabel.scale.set(this.achievementWidth, ACHIEVEMENT_ICON_HEIGHT, 1);
      }
      this.prevAchievementKey = key;
      // The canvas is measured as it is drawn, so unlike the MSDF lines around
      // it there is no text-updated event to wait for before the plate can be
      // sized to fit.
      this.updateNametagWidth();
    }
    this.achievementLabel.position.set(this.textOffsetX, this.achievementRowY, 0.001);
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
    // Awards and status each take a row of their own when both are present,
    // which is what used to leave them sitting on top of the name.
    const hasAwards = achievementEmoji(this.achievement).length > 0;
    const hasStatus = !!this.statusLabel();
    const layout = NAMETAG_LAYOUTS[(hasAwards ? 1 : 0) + (hasStatus ? 1 : 0)];
    this.nameTagHeight = layout.height;
    this.nameTagOffset = layout.offset;
    this.nameTagTextY = layout.nameY;
    // The volume bar and the typing dots ride just inside the bottom edge,
    // wherever that edge has ended up.
    this.nameTagVolumeY = -layout.height / 2 + 0.05;
    this.achievementRowY = layout.firstY;
    this.statusRowY = hasAwards ? layout.secondY : layout.firstY;

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
    this.size.x = Math.max(
      this.size.x,
      this.achievementWidth,
      statusTextSize,
      this.customStatusWidth,
      NAMETAG_MIN_WIDTH
    );
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

  // The status and private-zone badges stand at the right end of the plate, filling
  // its height; the away mark sits at the left, in front of the name, at a fraction
  // of their size. The text is shifted by half the difference between the two sides.
  // Kept apart from updateElements so a private zone opening or closing does not
  // re-run the hand-raised animation with it.
  applyIconLayout() {
    const iconSize = this.nameTagHeight - NAMETAG_STATUS_ICON_PADDING * 2;
    this.statusIconSize = this.statusIconTexture() ? iconSize : 0;
    this.privateZoneIconSize = this.isInPrivateZone ? iconSize : 0;
    // Deliberately smaller than the badges on the right, and in front of the name
    // rather than beside them: it is a footnote about where somebody is looking, not
    // a status they chose, and at badge size it dominated the whole plate.
    const awayIcon = this.isPageHidden ? getAwayIconTexture() : null;
    this.awayIconHeight = awayIcon ? iconSize * NAMETAG_AWAY_ICON_SCALE : 0;
    this.awayIconSize = awayIcon ? this.awayIconHeight * awayIcon.aspect : 0;

    // Right-hand badges push the text left, the away mark pushes it right.
    this.textOffsetX = (this.awayIconSize - this.statusIconSize - this.privateZoneIconSize) / 2;

    this.awayIcon.visible = !!awayIcon;
    if (awayIcon) {
      this.awayIcon.material.map = awayIcon.texture;
      this.awayIcon.material.needsUpdate = true;
      this.awayIcon.scale.set(this.awayIconSize, this.awayIconHeight, 1);
      this.awayIcon.matrixNeedsUpdate = true;
    }

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
    // Every icon that shares the row has to be in here, or the plate stays the size
    // of the text alone and the name runs out from under it.
    const width =
      this.size.x + NAMETAG_BACKGROUND_PADDING * 2 + this.statusIconSize + this.privateZoneIconSize + this.awayIconSize;
    // Kept for the top-down layout pass: the plate is the only part of the tag
    // whose width is worked out here rather than declared up front.
    this.nameTagWidth = width;
    this.nametagBackground.el.setAttribute("slice9", {
      width,
      height: this.nameTagHeight
    });
    this.nametagStatusBorder.el.setAttribute("slice9", {
      width: width + NAMETAG_STATUS_BORDER_PADDING,
      height: this.nameTagHeight + NAMETAG_STATUS_BORDER_PADDING
    });
    if (this.awayIconSize) {
      this.awayIcon.position.set(-width / 2 + NAMETAG_STATUS_ICON_PADDING + this.awayIconSize / 2, 0, 0.002);
      this.awayIcon.matrixNeedsUpdate = true;
    }

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
