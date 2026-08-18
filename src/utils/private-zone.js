// Private zone (vegamix): a narrow bubble for a side conversation.
//
// Pressing the ear button makes you the *owner* of a bubble of
// PRIVATE_ZONE_RADIUS around yourself. Everyone standing inside it is pulled
// into that bubble whether they asked to be or not, and drops out again the
// moment either of you walks away — which is why a pulled-in person cannot
// switch it off: they are not the one holding it open.
//
// Who can hear whom follows from bubble membership alone: two people hear each
// other if they share a bubble, or if neither is in one. So an outsider hears
// nobody in the bubble and nobody in the bubble hears them, while everyone
// inside talks normally. Only owners create bubbles — being pulled into one
// does not make you an owner — otherwise a chain of neighbours would spread the
// zone across the room.
//
// Every client computes the same thing from the same inputs: avatar positions,
// which are networked anyway, and one networked flag per person saying "I am an
// owner" (`player-info.privateZone`, alongside `muted`). Reticulum is untouched,
// nothing is persisted, and the outgoing half — nobody hearing you — is
// therefore enforced by the listeners' clients rather than by muting your
// microphone, which the people beside you still need.

// Metres. Deliberately far below the ~8 m at which someone counts as a
// neighbour for the tiles panel, so the difference is unmistakable.
export const PRIVATE_ZONE_RADIUS = 3;

// Used for the ear badge wherever it appears — the corner indicator, the tiles
// and the in-world name tags — so all of them read as one signal.
export const PRIVATE_ZONE_COLOR = "#3B9DFF";

const EMPTY = new Set();
const listeners = new Set();

// Ours is held here rather than read back from the component: this is what the
// button means, and the component is kept in step with it.
let ownPrivateZone = false;
// Derived, recomputed every pass of the private zone system.
let active = false;
let locked = false;
let mySessionId = null;
const bubblesBySession = new Map();

const positionPool = [];
const people = [];

function pooledPosition(index) {
  if (!positionPool[index]) positionPool[index] = new THREE.Vector3();
  return positionPool[index];
}

export function isPrivateZoneOwn() {
  return ownPrivateZone;
}

// True when a bubble covers us, ours or somebody else's.
export function isPrivateZoneActive() {
  return active;
}

// True when somebody else's bubble covers us: the button is theirs to release,
// not ours.
export function isPrivateZoneLocked() {
  return locked;
}

export function isSessionInPrivateZone(sessionId) {
  const bubbles = bubblesBySession.get(sessionId);
  return !!bubbles && bubbles.size > 0;
}

// Whether we and this person share a bubble — or are both outside every bubble,
// which is the ordinary case where the zone has nothing to say.
export function canHearSession(sessionId) {
  const mine = (mySessionId && bubblesBySession.get(mySessionId)) || EMPTY;
  const theirs = bubblesBySession.get(sessionId) || EMPTY;
  if (mine.size === 0) return theirs.size === 0;
  for (const owner of mine) {
    if (theirs.has(owner)) return true;
  }
  return false;
}

// Whether a private zone — ours or theirs — cuts this person off from us.
export function privateZoneSilences(playerInfo) {
  if (!playerInfo || !playerInfo.el || playerInfo.isLocalPlayerInfo) return false;
  return !canHearSession(playerInfo.playerSessionId);
}

function notify() {
  for (const listener of listeners) listener({ active, locked, own: ownPrivateZone });
}

// Rebuilds "who is in which bubble" for everyone in the room. Called from the
// private zone system; everything else reads the result.
export function recomputePrivateZones() {
  mySessionId = (typeof NAF !== "undefined" && NAF.clientId) || mySessionId;

  people.length = 0;
  const playerInfos = (APP.componentRegistry && APP.componentRegistry["player-info"]) || [];
  for (const playerInfo of playerInfos) {
    if (!playerInfo.el) continue;
    const sessionId = playerInfo.isLocalPlayerInfo ? mySessionId : playerInfo.playerSessionId;
    if (!sessionId) continue;
    const position = pooledPosition(people.length);
    playerInfo.el.object3D.getWorldPosition(position);
    people.push({
      sessionId,
      position,
      // Ours is authoritative locally; theirs arrives on the component.
      isOwner: playerInfo.isLocalPlayerInfo ? ownPrivateZone : !!playerInfo.data.privateZone
    });
  }

  bubblesBySession.clear();
  for (const person of people) {
    let bubbles = null;
    for (const owner of people) {
      if (!owner.isOwner) continue;
      // An owner is trivially inside their own bubble, so this also covers them.
      if (owner.position.distanceTo(person.position) > PRIVATE_ZONE_RADIUS) continue;
      if (!bubbles) bubbles = new Set();
      bubbles.add(owner.sessionId);
    }
    if (bubbles) bubblesBySession.set(person.sessionId, bubbles);
  }

  const myBubbles = (mySessionId && bubblesBySession.get(mySessionId)) || EMPTY;
  let nextLocked = false;
  for (const owner of myBubbles) {
    if (owner !== mySessionId) {
      nextLocked = true;
      break;
    }
  }
  const nextActive = myBubbles.size > 0;

  if (nextActive !== active || nextLocked !== locked) {
    active = nextActive;
    locked = nextLocked;
    notify();
  }
}

export function setOwnPrivateZone(on) {
  const next = !!on;
  if (next === ownPrivateZone) return;
  ownPrivateZone = next;

  // Networked so the people around us can work out the same bubbles we do.
  const rig = document.getElementById("avatar-rig");
  if (rig) rig.setAttribute("player-info", { privateZone: ownPrivateZone });

  // Recomputed here as well as on the system's own beat, so the button and the
  // corner badge answer the press immediately rather than a frame or two later.
  recomputePrivateZones();
  notify();
}

export function toggleOwnPrivateZone() {
  // Someone else is holding the bubble open; releasing it is not ours to do.
  if (locked) return;
  setOwnPrivateZone(!ownPrivateZone);
}

// Returns an unsubscribe function, so React effects can just return it.
export function onPrivateZoneChanged(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
