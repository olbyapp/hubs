import { getPlayerInfo } from "./component-utils";
import { getPresenceProfileForSession } from "./phoenix-utils";

// Tiles only show people close enough to talk to, so the panel mirrors walking
// up to someone rather than listing the whole room. Roughly where avatar audio
// has faded out (AvatarAudioDefaults: refDistance 5, rolloffFactor 5).
export const TILE_AUDIBLE_DISTANCE = 12;

const localPosition = new THREE.Vector3();
const remotePosition = new THREE.Vector3();

function isUsableTrack(track) {
  return !!track && track.readyState === "live";
}

// Camera and screenshare are mutually exclusive in Hubs (starting one stops the
// other), so a participant has at most one video track and therefore one tile.
function getLocalVideoTrack() {
  const stream = APP.mediaDevicesManager && APP.mediaDevicesManager.mediaStream;
  if (!stream) return null;
  const tracks = stream.getVideoTracks().filter(isUsableTrack);
  return tracks.length ? tracks[tracks.length - 1] : null;
}

// Read the consumers directly instead of APP.dialog.getMediaStream(): that
// helper parks a promise that never resolves when the peer is not producing,
// and a second call for the same peer orphans the first one.
function getRemoteVideoTracks() {
  const tracksBySession = new Map();
  const consumers = APP.dialog && APP.dialog._consumers;
  if (!consumers) return tracksBySession;
  consumers.forEach(consumer => {
    const peerId = consumer.appData && consumer.appData.peerId;
    if (!peerId || consumer.closed) return;
    if (!isUsableTrack(consumer.track) || consumer.track.kind !== "video") return;
    tracksBySession.set(peerId, consumer.track);
  });
  return tracksBySession;
}

function displayNameFor(presences, sessionId) {
  const profile = getPresenceProfileForSession(presences, sessionId);
  return (profile && profile.displayName) || "";
}

export function collectVideoTiles(presences, mySessionId) {
  const tiles = [];

  const localTrack = getLocalVideoTrack();
  if (localTrack) {
    tiles.push({
      key: `local-${localTrack.id}`,
      sessionId: mySessionId,
      isLocal: true,
      isScreen: localTrack._hubs_contentHint === "screen",
      name: displayNameFor(presences, mySessionId),
      track: localTrack
    });
  }

  const avatarRig = document.getElementById("avatar-rig");
  if (!avatarRig) return tiles;
  avatarRig.object3D.getWorldPosition(localPosition);

  getRemoteVideoTracks().forEach((track, sessionId) => {
    if (sessionId === mySessionId) return;
    const playerInfo = getPlayerInfo(sessionId);
    if (!playerInfo || !playerInfo.el) return;
    playerInfo.el.object3D.getWorldPosition(remotePosition);
    if (remotePosition.distanceTo(localPosition) > TILE_AUDIBLE_DISTANCE) return;
    tiles.push({
      key: `${sessionId}-${track.id}`,
      sessionId,
      isLocal: false,
      isScreen: false,
      name: displayNameFor(presences, sessionId),
      track
    });
  });

  return tiles;
}

export function sameTiles(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].key !== b[i].key || a[i].name !== b[i].name) return false;
  }
  return true;
}

// Remote avatars carry a debounced "is talking" flag, the same one the in-world
// name tag lights its border with, so tiles and name tags agree on who is
// speaking. Your own avatar has no analyser — nobody consumes your voice back —
// so the local mic level is read instead and held for the same beat, otherwise
// your own tile would strobe between words.
const LOCAL_TALKING_HOLD_MS = 1000;
const LOCAL_TALKING_VOLUME = 0.01;
let localTalkingUntil = 0;

export function collectTalkingSessions(mySessionId) {
  const talking = new Set();

  const analysers = (APP.componentRegistry && APP.componentRegistry["networked-audio-analyser"]) || [];
  for (const analyser of analysers) {
    if (analyser.avatarIsTalking && analyser.playerSessionId) {
      talking.add(analyser.playerSessionId);
    }
  }

  const scene = AFRAME.scenes[0];
  const localAnalyser = scene && scene.systems["local-audio-analyser"];
  if (localAnalyser) {
    const now = performance.now();
    if (localAnalyser.volume > LOCAL_TALKING_VOLUME) {
      localTalkingUntil = now + LOCAL_TALKING_HOLD_MS;
    }
    if (now < localTalkingUntil && mySessionId) {
      talking.add(mySessionId);
    }
  }

  return talking;
}

export function sameSessions(a, b) {
  if (a.size !== b.size) return false;
  for (const sessionId of a) {
    if (!b.has(sessionId)) return false;
  }
  return true;
}
