// Private zone (vegamix): a narrow "whisper" radius for a side conversation.
// Switching it on shrinks both how far you hear and how far you are heard down
// to PRIVATE_ZONE_RADIUS, so two people standing together can talk without the
// rest of the room following along.
//
// The outgoing half is enforced by everyone else's client, not by muting the
// microphone: the flag rides along on the networked `player-info` component
// (like `muted` does), and every client applies the same symmetric rule to every
// pair — if either of you is in a private zone, you only reach each other inside
// the radius. Both sides measure the same distance, so both sides agree.
// Reticulum is not involved, and nothing is persisted: the flag lives for the
// session only, which is what "off by default" means here.

// Metres. Deliberately far below the ~8 m at which someone counts as a
// neighbour for the tiles panel, so the difference is unmistakable.
export const PRIVATE_ZONE_RADIUS = 3;

const listeners = new Set();
let privateZoneOn = false;

const localPosition = new THREE.Vector3();
const remotePosition = new THREE.Vector3();

export function isPrivateZoneOn() {
  return privateZoneOn;
}

export function setPrivateZone(on) {
  const next = !!on;
  if (next === privateZoneOn) return;
  privateZoneOn = next;

  // Networked so that the people around you can silence you at their end.
  const rig = document.getElementById("avatar-rig");
  if (rig) rig.setAttribute("player-info", { privateZone: privateZoneOn });

  for (const listener of listeners) listener(privateZoneOn);
}

export function togglePrivateZone() {
  setPrivateZone(!privateZoneOn);
}

// Returns an unsubscribe function, so React effects can just return it.
export function onPrivateZoneChanged(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Whether a private zone — yours or theirs — cuts this person off from you.
// Takes the player-info component: it carries both the networked flag and the
// avatar to measure from.
export function privateZoneSilences(playerInfo) {
  if (!playerInfo || !playerInfo.el || playerInfo.isLocalPlayerInfo) return false;
  if (!privateZoneOn && !playerInfo.data.privateZone) return false;

  const rig = document.getElementById("avatar-rig");
  if (!rig) return false;
  rig.object3D.getWorldPosition(localPosition);
  playerInfo.el.object3D.getWorldPosition(remotePosition);
  return remotePosition.distanceTo(localPosition) > PRIVATE_ZONE_RADIUS;
}
