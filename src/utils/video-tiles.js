import { getPresenceProfileForSession } from "./phoenix-utils";
import { calculateAttenuation } from "../systems/audio-gain-system";
import { privateZoneSilences } from "./private-zone";

// Tiles show the people you are in earshot of, so the panel mirrors walking up
// to someone rather than listing the whole room. The test is how loud they
// actually reach you — the same distance model the audio itself uses, plus any
// gain an audio zone imposes — not plain distance, which counted people you
// could barely hear through a wall or from another zone as neighbours.
// At avatar defaults (inverse, refDistance 5, rolloff 5) this is about 8 metres.
const TILE_AUDIBILITY_THRESHOLD = 0.25;
// Used only for people with no audio node yet: someone who has never switched
// their mic on has nothing to attenuate, and they should still get a tile when
// they are standing next to you.
const TILE_FALLBACK_DISTANCE = 8;

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

// How loudly this person reaches the listener, 0..1, or null when they have no
// audio to judge by. Deliberately ignores mute and per-person volume: those say
// what you want to hear, while a tile is about whether they are near enough to
// be part of your conversation.
function audibilityOf(playerInfoEl) {
  const audioEl = playerInfoEl.querySelector("[avatar-audio-source]");
  const audio = audioEl && APP.audios.get(audioEl);
  if (!audio || !APP.audioListener) return null;
  const zoneOverrides = APP.zoneOverrides.get(audioEl);
  const zoneGain = zoneOverrides && zoneOverrides.gain !== undefined ? zoneOverrides.gain : 1;
  return zoneGain * calculateAttenuation(audioEl, audio);
}

function isNeighbour(playerInfo) {
  // A private zone, yours or theirs, is the whole answer when it applies: it
  // silences them, so they are not part of your conversation at all.
  if (privateZoneSilences(playerInfo)) return false;

  const audibility = audibilityOf(playerInfo.el);
  if (audibility !== null) return audibility >= TILE_AUDIBILITY_THRESHOLD;

  playerInfo.el.object3D.getWorldPosition(remotePosition);
  return remotePosition.distanceTo(localPosition) <= TILE_FALLBACK_DISTANCE;
}

function displayNameFor(presences, sessionId) {
  const profile = getPresenceProfileForSession(presences, sessionId);
  return (profile && profile.displayName) || "";
}

function statusFor(presences, sessionId) {
  const profile = getPresenceProfileForSession(presences, sessionId);
  return (profile && profile.status) || "none";
}

// Everyone within earshot gets a tile, camera or no camera: the panel is the
// list of people you are talking to, and someone with their camera off is still
// one of them — their tile just carries their name instead of a picture.
export function collectVideoTiles(presences, mySessionId) {
  const tiles = [];

  const localTrack = getLocalVideoTrack();
  if (localTrack) {
    tiles.push({
      // Keyed by session rather than by track: the tile survives switching
      // between camera and screenshare, so the spotlight does not close.
      key: mySessionId || "local",
      sessionId: mySessionId,
      isLocal: true,
      isScreen: localTrack._hubs_contentHint === "screen",
      name: displayNameFor(presences, mySessionId),
      track: localTrack,
      micMuted: !(APP.mediaDevicesManager && APP.mediaDevicesManager.isMicEnabled),
      status: statusFor(presences, mySessionId)
    });
  }

  const avatarRig = document.getElementById("avatar-rig");
  if (!avatarRig) return tiles;
  avatarRig.object3D.getWorldPosition(localPosition);

  const remoteTracks = getRemoteVideoTracks();
  const playerInfos = (APP.componentRegistry && APP.componentRegistry["player-info"]) || [];
  for (const playerInfo of playerInfos) {
    if (playerInfo.isLocalPlayerInfo || !playerInfo.el) continue;
    const sessionId = playerInfo.playerSessionId;
    if (!sessionId || sessionId === mySessionId) continue;
    if (!isNeighbour(playerInfo)) continue;

    tiles.push({
      key: sessionId,
      sessionId,
      isLocal: false,
      isScreen: false,
      name: displayNameFor(presences, sessionId) || playerInfo.displayName || "",
      track: remoteTracks.get(sessionId) || null,
      micMuted: !!playerInfo.data.muted,
      status: statusFor(presences, sessionId)
    });
  }

  return tiles;
}

export function sameTiles(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].key !== b[i].key ||
      a[i].name !== b[i].name ||
      a[i].track !== b[i].track ||
      a[i].isScreen !== b[i].isScreen ||
      a[i].micMuted !== b[i].micMuted ||
      a[i].status !== b[i].status
    ) {
      return false;
    }
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
