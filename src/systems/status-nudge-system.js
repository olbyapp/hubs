// Movement in a quiet status (vegamix): people set Thinking or AFK, then start
// walking around again and forget the badge is still on their nametag, so the
// room keeps tiptoeing around someone who is plainly back. Walking or looking
// around is the tell, so that is what re-opens the question. It asks rather
// than switching by itself the way the mic does: a hand knocks a movement key
// far more easily than it unmutes, and silently dropping AFK on someone who
// really is away is the worse mistake of the two.

import { paths } from "./userinput/paths";
import { getOwnStatus, isQuietStatus } from "../utils/user-status";

// A deliberate look around rather than the drift of a hand resting on the
// mouse: yaw and pitch summed, in radians, so roughly a quarter turn.
const LOOK_THRESHOLD_RAD = 0.5;

// Long enough to rule out a key brushed in passing, short enough that a real
// step across the room asks straight away.
const WALK_THRESHOLD_MS = 350;

// Input arrives in bursts. Anything not followed up inside this window was a
// twitch and not a return, so the tally starts over.
const IDLE_RESET_MS = 1500;

// React renders the modal a frame or two after the event goes out, so the
// screen does not read as busy immediately. Only past this is a free screen
// evidence that the modal is gone.
const PROMPT_SETTLE_MS = 1000;

// After "no, keep it" the question is settled for a while — someone who really
// is away but fidgeting must not be asked again every minute.
const SNOOZE_MS = 5 * 60 * 1000;

// Fired on window; ui-root is what actually puts the modal up.
export const STATUS_NUDGE_EVENT = "quiet_status_activity";

let promptOpen = false;
let promptOpenedAt = 0;
let mutedUntil = 0;
let walkedMs = 0;
let lookedRad = 0;
let lastInputAt = 0;
let lastStatus = null;

function forget() {
  walkedMs = 0;
  lookedRad = 0;
}

// Anything at all is over the scene — a sidebar, a modal, the entry flow. Only
// used to tell that our own modal has gone; whether one may be put up in the
// first place is ui-root's call, since it can tell a sidebar from a modal.
const screenIsBusy = (function () {
  let uiRoot;
  return function screenIsBusy() {
    uiRoot = uiRoot || document.getElementById("ui-root");
    return (
      (uiRoot && uiRoot.children[0] && uiRoot.children[0].classList.contains("in-modal-or-overlay")) ||
      !!window.APP.preferenceScreenIsVisible
    );
  };
})();

// Called by the modal on its way out. Answering "yes" leaves the quiet status,
// which stands this system down by itself; answering "no" — or closing the
// modal, which means the same thing — buys silence for a while.
export function closeStatusNudge({ snooze } = {}) {
  promptOpen = false;
  forget();
  mutedUntil = snooze ? performance.now() + SNOOZE_MS : 0;
}

export class StatusNudgeSystem {
  constructor(sceneEl) {
    this.sceneEl = sceneEl;
  }

  tick(dt) {
    const status = getOwnStatus();
    if (status !== lastStatus) {
      // A status the user just picked deserves a fresh hearing, including the
      // quiet one they pick seconds after being asked about the previous one.
      lastStatus = status;
      mutedUntil = 0;
      forget();
    }

    if (promptOpen) {
      // Our modal can be shoved aside by anything else that takes the screen —
      // a media browser opened from the toolbar behind it — and then no answer
      // is ever coming. A screen that has gone free again says it is gone.
      if (performance.now() - promptOpenedAt > PROMPT_SETTLE_MS && !screenIsBusy()) closeStatusNudge();
      return;
    }

    if (!isQuietStatus(status) || !this.sceneEl.is("entered")) return;

    const userinput = this.sceneEl.systems.userinput;
    if (!userinput) return;

    const now = performance.now();
    if (now - lastInputAt > IDLE_RESET_MS) forget();

    const acceleration = userinput.get(paths.actions.characterAcceleration);
    if (acceleration && (acceleration[0] || acceleration[1])) {
      walkedMs += dt;
      lastInputAt = now;
    }

    const cameraDelta = userinput.get(paths.actions.cameraDelta);
    if (cameraDelta && (cameraDelta[0] || cameraDelta[1])) {
      lookedRad += Math.abs(cameraDelta[0]) + Math.abs(cameraDelta[1]);
      lastInputAt = now;
    }

    // A snap turn or a teleport is a whole gesture rather than a trickle of
    // deltas — there is nothing to accumulate, one of them is already an answer.
    const wholeGesture =
      userinput.get(paths.actions.snapRotateLeft) ||
      userinput.get(paths.actions.snapRotateRight) ||
      userinput.get(paths.actions.startGazeTeleport) ||
      userinput.get(paths.actions.leftHand.startTeleport) ||
      userinput.get(paths.actions.rightHand.startTeleport);

    if (!wholeGesture && walkedMs < WALK_THRESHOLD_MS && lookedRad < LOOK_THRESHOLD_RAD) return;
    if (now < mutedUntil) return;

    promptOpen = true;
    promptOpenedAt = now;
    forget();
    window.dispatchEvent(new CustomEvent(STATUS_NUDGE_EVENT, { detail: { status } }));
  }
}
