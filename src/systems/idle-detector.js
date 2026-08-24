import { paths } from "./userinput/paths";
import { calculateVolume } from "../components/audio-feedback";

const qs = new URLSearchParams(location.search);

// Two hours suited a public instance, where the timer is really there to hand a room
// slot back. An office desktop tab is meant to stay open across the working day, so it
// gets twelve; a phone left in a pocket still holding a slot is exactly what we do want
// to reclaim, so it gets one.
const isMobile = AFRAME.utils.device.isMobile();
const DEFAULT_IDLE_TIMEOUT_S = isMobile ? 60 * 60 : 12 * 60 * 60;
const IDLE_TIMEOUT_MS = (parseInt(qs.get("idle_timeout"), 10) || DEFAULT_IDLE_TIMEOUT_S) * 1000;
const INPUT_CHECK_INTERVAL_MS = 1000;

// Speaking counts as activity. The timer used to watch only pointer, keyboard and
// movement, so someone who spent a meeting talking and listening registered as idle and
// was disconnected mid-conversation - the one thing a voice office must not do.
//
// A muted mic deliberately does not count. Its analyser keeps reading while muted (see
// audio-system), but an open muted mic in a noisy room would hold the session forever
// and there would be no idle timer left at all.
//
// Threshold and smoothing match speaking-while-muted-system and office-stats: 0.05 is
// where the toolbar's own level meter first moves.
const SPEAKING_VOLUME_THRESHOLD = 0.05;
const SPEAKING_SMOOTHING = 0.3;

const CHARACTER_ACCELERATION_PATH = paths.actions.characterAcceleration;
const BASIC_ACTIVITY_PATHS = [
  paths.actions.startGazeTeleport,
  paths.actions.rightHand.startTeleport,
  paths.actions.leftHand.startTeleport,
  paths.actions.snapRotateRight,
  paths.actions.snapRotateLeft,
  paths.actions.cursor.right.grab,
  paths.actions.cursor.left.grab,
  paths.actions.rightHand.grab,
  paths.actions.leftHand.grab,
  paths.actions.angularVelocity
];

AFRAME.registerSystem("idle-detector", {
  init() {
    this.resetTimeout = this.resetTimeout.bind(this);
    this.idleTimeout = null;
    this.lastInputCheck = 0;
    this.micVolume = 0;

    const events = ["click", "pointerdown", "touchstart", "keyup"];

    for (const event of events) {
      window.addEventListener(event, this.resetTimeout);
    }

    this.resetTimeout();
  },
  resetTimeout() {
    if (this.idleTimeout) clearTimeout(this.idleTimeout);
    this.idleTimeout = setTimeout(this.onIdleTimeout, IDLE_TIMEOUT_MS);
    window.dispatchEvent(new CustomEvent("activity_detected"));
  },
  onIdleTimeout() {
    window.dispatchEvent(new CustomEvent("idle_detected"));
  },
  // Sampled every frame rather than on the interval below: speech is mostly gaps, and
  // the analyser window is well under a millisecond, so a once-a-second peek would keep
  // landing between words. Smoothing is what turns it into "is talking".
  updateMicVolume() {
    const hubsSystems = this.el.systems["hubs-systems"];
    const audioSystem = hubsSystems && hubsSystems.audioSystem;
    const mediaDevicesManager = window.APP && window.APP.mediaDevicesManager;

    if (!audioSystem || !audioSystem.micAnalyser || !mediaDevicesManager || !mediaDevicesManager.isMicEnabled) {
      this.micVolume = 0;
      return;
    }

    const raw = calculateVolume(audioSystem.micAnalyser, audioSystem.micAnalyserLevels);
    this.micVolume = SPEAKING_SMOOTHING * raw + (1 - SPEAKING_SMOOTHING) * this.micVolume;
  },

  tick(time) {
    this.updateMicVolume();

    if (time - this.lastInputCheck < INPUT_CHECK_INTERVAL_MS) return;
    // Stock never assigned this, so the interval above only ever held for the first
    // second and the block below then ran every frame.
    this.lastInputCheck = time;

    const userinput = this.el.systems.userinput;

    let basicActivity = false;
    for (const activityPath of BASIC_ACTIVITY_PATHS) {
      basicActivity = basicActivity || !!userinput.get(activityPath);
    }

    const characterAcceleration = userinput.get(CHARACTER_ACCELERATION_PATH);

    const active =
      basicActivity ||
      !!(characterAcceleration && characterAcceleration[0]) ||
      !!(characterAcceleration && characterAcceleration[1]) ||
      this.micVolume > SPEAKING_VOLUME_THRESHOLD;

    if (active) {
      this.resetTimeout();
    }
  },
  remove() {}
});
