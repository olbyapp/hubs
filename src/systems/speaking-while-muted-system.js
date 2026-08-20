// Talking into a muted mic (vegamix): the room stays polite and silent, the
// toolbar mic button is small, and the level meter that would give it away is
// hidden behind a popover — so people deliver a whole answer before anyone
// tells them nobody heard it. The signal is still there while muted: muting
// pauses the outbound WebRTC track, which sits downstream of the Web Audio
// graph, so audio-system's micAnalyser keeps seeing the real microphone. The
// tell is simply voiced energy on an input nobody is receiving.

import { calculateVolume } from "../components/audio-feedback";

// Smoothed RMS of the raw mic. 0.05 is where the toolbar's own level meter
// first moves (its floor of 0.08 perceived maps back to ~0.049 raw), so this
// fires at exactly the level the user would have seen had they been looking.
const SPEAKING_VOLUME_THRESHOLD = 0.05;

// The analyser window is well under a millisecond and speech is mostly gaps,
// so the level swings hard frame to frame. Same smoothing the mic meter uses,
// which keeps the two agreeing about what counts as loud.
const SMOOTHING = 0.3;

// Voiced time to accumulate before saying anything — a syllable or two. Longer
// than a cough or a chair, short enough to catch the first half of a sentence.
const VOICED_TIME_MS = 600;

// Speech is voiced in bursts; a pause this long is the end of an utterance
// rather than a gap between words, so the tally starts over.
const QUIET_RESET_MS = 1500;

// Someone who keeps talking is not helped by being told a second time straight
// away. One reminder, then silence long enough that the next one means
// something.
const REPEAT_COOLDOWN_MS = 15000;

// Fired on window; ui-root is what actually puts the notification up.
export const SPEAKING_WHILE_MUTED_EVENT = "speaking_while_muted";

export class SpeakingWhileMutedSystem {
  constructor(sceneEl) {
    this.sceneEl = sceneEl;
    this.volume = 0;
    this.voicedMs = 0;
    this.quietMs = 0;
    this.notifiedAt = 0;
  }

  forget() {
    this.volume = 0;
    this.voicedMs = 0;
    this.quietMs = 0;
  }

  tick(dt) {
    if (!this.sceneEl.is("entered")) return;

    const mediaDevicesManager = APP.mediaDevicesManager;
    // No shared mic means no signal to read, and no permission to unmute back
    // into. A room that has taken voice_chat away is not something the user can
    // undo either, so nudging them at the mic button would only mislead.
    if (!mediaDevicesManager || !mediaDevicesManager.isMicShared || !APP.hubChannel?.can("voice_chat")) {
      this.forget();
      return;
    }

    if (mediaDevicesManager.isMicEnabled) {
      // Unmuted: nothing to warn about, and hearing themselves go out is the
      // best possible reset for the next time they mute.
      this.forget();
      return;
    }

    const audioSystem = this.sceneEl.systems["hubs-systems"].audioSystem;
    const analyser = audioSystem && audioSystem.micAnalyser;
    if (!analyser) return;

    const raw = calculateVolume(analyser, audioSystem.micAnalyserLevels);
    this.volume = SMOOTHING * raw + (1 - SMOOTHING) * this.volume;

    if (this.volume > SPEAKING_VOLUME_THRESHOLD) {
      this.voicedMs += dt;
      this.quietMs = 0;
    } else {
      this.quietMs += dt;
      if (this.quietMs > QUIET_RESET_MS) this.forget();
      return;
    }

    if (this.voicedMs < VOICED_TIME_MS) return;

    const now = performance.now();
    if (this.notifiedAt && now - this.notifiedAt < REPEAT_COOLDOWN_MS) return;

    this.notifiedAt = now;
    this.forget();
    window.dispatchEvent(new CustomEvent(SPEAKING_WHILE_MUTED_EVENT));
  }
}
