import { updateAudioSettings } from "../update-audio-settings";
import { isPrivateZoneOn, privateZoneSilences } from "../utils/private-zone";

// People walk, so who a private zone cuts off changes without an event to
// subscribe to. Polled rather than run every frame: the answer only changes when
// someone crosses the radius, and a fifth of a second of lag is inaudible.
const EVALUATE_INTERVAL_MS = 200;

// Applies the private zone to incoming voice: whoever it silences gets gain 0
// through APP.privateZoneMutedState, which getCurrentAudioSettings honours the
// same way it honours a manual mute. Kept apart from APP.mutedState so that
// leaving a private zone cannot undo a mute the listener set by hand.
export class PrivateZoneSystem {
  constructor() {
    this.lastEvaluatedAt = 0;
    this.live = new Set();
  }

  tick(t) {
    if (t - this.lastEvaluatedAt < EVALUATE_INTERVAL_MS) return;
    this.lastEvaluatedAt = t;

    this.reassertOwnFlag();

    this.live.clear();
    const playerInfos = (APP.componentRegistry && APP.componentRegistry["player-info"]) || [];
    for (const playerInfo of playerInfos) {
      if (playerInfo.isLocalPlayerInfo) continue;
      const audioEl = playerInfo.el.querySelector("[avatar-audio-source]");
      if (!audioEl) continue;
      this.live.add(audioEl);

      const silenced = privateZoneSilences(playerInfo);
      if (silenced === APP.privateZoneMutedState.has(audioEl)) continue;

      if (silenced) {
        APP.privateZoneMutedState.add(audioEl);
      } else {
        APP.privateZoneMutedState.delete(audioEl);
      }
      // No audio node yet is fine: whenever one appears it reads the current
      // settings, and this entry is part of them.
      const audio = APP.audios.get(audioEl);
      if (audio) updateAudioSettings(audioEl, audio);
    }

    // Avatars of people who left would otherwise be held alive by this set.
    for (const audioEl of APP.privateZoneMutedState) {
      if (!this.live.has(audioEl)) APP.privateZoneMutedState.delete(audioEl);
    }
  }

  // Everything the outgoing half of a private zone depends on is the networked
  // flag on our own avatar, and that avatar is rebuilt from scratch when you
  // move between hubs — it comes back with the flag off while the button still
  // reads pressed. Silently being heard when you believe you are not is the one
  // failure this feature must not have, so the two are compared every pass; the
  // write only happens on a genuine mismatch.
  reassertOwnFlag() {
    const rig = document.getElementById("avatar-rig");
    const playerInfo = rig && rig.components["player-info"];
    if (!playerInfo) return;
    const on = isPrivateZoneOn();
    if (playerInfo.data.privateZone !== on) rig.setAttribute("player-info", { privateZone: on });
  }
}
