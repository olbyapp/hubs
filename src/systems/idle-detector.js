import { paths } from "./userinput/paths";
import { calculateVolume } from "../components/audio-feedback";

const qs = new URLSearchParams(location.search);

// Two hours suited a public instance, where the timer is really there to hand a room
// slot back. Here five hours is office policy: an avatar frozen that long is a left
// tab, not a person, so it is warned and let go — and hub-stats discards the frozen
// stretch instead of crediting it (office-stats.js posts idleMs off this detector's
// activity events). A phone left in a pocket still gets the tighter hour.
const isMobile = AFRAME.utils.device.isMobile();
const DEFAULT_IDLE_TIMEOUT_S = isMobile ? 60 * 60 : 5 * 60 * 60;
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
    this.lastResetAt = 0;
    this.micVolume = 0;

    const events = ["click", "pointerdown", "touchstart", "keyup"];

    for (const event of events) {
      window.addEventListener(event, this.resetTimeout);
    }

    // Watching also counts. The stock list is clicks and keys only, which reads
    // someone following a half-hour screen share, muted and hand on mouse, as
    // absent — and a frozen tab gets no mousemove anyway, so this loosens
    // nothing about the kick. Throttled because these arrive at frame rate and
    // resetTimeout re-arms a timer and dispatches an event each call.
    this.onWatchActivity = () => {
      if (Date.now() - this.lastResetAt < INPUT_CHECK_INTERVAL_MS) return;
      this.resetTimeout();
    };
    window.addEventListener("mousemove", this.onWatchActivity);
    window.addEventListener("wheel", this.onWatchActivity);

    // The speech check cannot live only on the render tick: the tick stops in a
    // hidden tab, and someone talking through a meeting with the office behind
    // their editor must not hit the idle exit mid-sentence. An interval keeps
    // running there (a tab holding WebRTC is exempt from the browser's intensive
    // throttling), and the Web Audio analyser it reads really does keep going.
    this.micCheckInterval = setInterval(() => {
      this.updateMicVolume();
      if (this.micVolume > SPEAKING_VOLUME_THRESHOLD) this.resetTimeout();
    }, INPUT_CHECK_INTERVAL_MS);

    this.resetTimeout();
  },
  resetTimeout() {
    if (this.idleTimeout) clearTimeout(this.idleTimeout);
    this.idleTimeout = setTimeout(this.onIdleTimeout, IDLE_TIMEOUT_MS);
    this.lastResetAt = Date.now();
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
  remove() {
    clearInterval(this.micCheckInterval);
  }
});
