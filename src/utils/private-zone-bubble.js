import { PRIVATE_ZONE_COLOR, PRIVATE_ZONE_RADIUS, isPrivateZoneOwn } from "./private-zone";

// The dome a private zone draws around its owner.
//
// A bubble pulls in whoever is standing inside it, whether they asked to be or
// not, so somebody walking past has to be able to see where it ends before they
// cross into it. The ear badge on a nametag only says that a zone exists; this
// says how far it reaches.
//
// Nothing new goes over the wire: every client already knows who owns a zone
// (`player-info.privateZone`) and the radius is a constant, so the dome is drawn
// from the very inputs that decide who hears whom. The owner test below is
// therefore the one from recomputePrivateZones, repeated rather than reworded —
// a boundary drawn from anything else would eventually disagree with the audio,
// and a boundary that lies is worse than none.

// Barely there head-on, bright at the silhouette: a uniform tint over a 3 m
// sphere fogs the faces of the people inside it, which is the one thing a
// conversation aid must not do. The rim carries the shape instead, and it works
// the same seen from inside as from outside.
const FACE_OPACITY = 0.05;
const RIM_OPACITY = 0.4;
const RIM_SHARPNESS = 2.5;

const VERTEX_SHADER = `
  varying vec3 vNormalView;
  varying vec3 vViewDir;
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vNormalView = normalize(normalMatrix * normal);
    vViewDir = normalize(-mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FRAGMENT_SHADER = `
  uniform vec3 color;
  uniform float faceOpacity;
  uniform float rimOpacity;
  uniform float rimSharpness;
  varying vec3 vNormalView;
  varying vec3 vViewDir;
  void main() {
    // abs() so that the inside of the dome shades like the outside: the normals
    // point outwards, and from within they face away from the eye.
    float facing = abs(dot(normalize(vNormalView), normalize(vViewDir)));
    float rim = pow(1.0 - facing, rimSharpness);
    gl_FragColor = vec4(color, mix(faceOpacity, rimOpacity, rim));
  }
`;

let geometry = null;
let material = null;

// Domes carry no state of their own beyond where they sit, so the pool hands
// them out by position in the list rather than per person, and the tail is
// simply hidden when fewer zones are open than a moment ago.
const bubbles = [];

function getGeometry() {
  if (!geometry) geometry = new THREE.SphereBufferGeometry(PRIVATE_ZONE_RADIUS, 32, 20);
  return geometry;
}

function getMaterial() {
  if (!material) {
    material = new THREE.ShaderMaterial({
      uniforms: {
        color: { value: new THREE.Color(PRIVATE_ZONE_COLOR) },
        faceOpacity: { value: FACE_OPACITY },
        rimOpacity: { value: RIM_OPACITY },
        rimSharpness: { value: RIM_SHARPNESS }
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      // Both halves are drawn — the far one reads as the back of the dome — and
      // neither writes depth, so nothing inside the bubble is cut out by it.
      side: THREE.DoubleSide,
      depthWrite: false
    });
  }
  return material;
}

function ensureBubble(index, sceneEl) {
  if (bubbles[index]) return bubbles[index];
  const mesh = new THREE.Mesh(getGeometry(), getMaterial());
  // Drawn before the other transparent things in the room so that name tags and
  // the ear badge stay legible through it rather than being tinted by it.
  mesh.renderOrder = -1;
  sceneEl.object3D.add(mesh);
  bubbles[index] = mesh;
  return mesh;
}

// Called every frame: people walk, and a boundary that trails behind its owner
// would be exactly as misleading as a wrong radius.
export function updatePrivateZoneBubbles() {
  const sceneEl = AFRAME.scenes[0];
  if (!sceneEl) return;

  let used = 0;
  const playerInfos = (APP.componentRegistry && APP.componentRegistry["player-info"]) || [];
  for (const playerInfo of playerInfos) {
    if (!playerInfo.el) continue;
    // Ours is authoritative locally; theirs arrives on the component.
    const isOwner = playerInfo.isLocalPlayerInfo ? isPrivateZoneOwn() : !!playerInfo.data.privateZone;
    if (!isOwner) continue;

    const mesh = ensureBubble(used++, sceneEl);
    // The avatar's own origin, at its feet, which is the point membership is
    // measured from. Half the sphere ends up under the floor and is hidden by
    // it, so what is left is a dome whose footprint is exactly the line you can
    // walk across.
    playerInfo.el.object3D.getWorldPosition(mesh.position);
    mesh.matrixNeedsUpdate = true;
    mesh.visible = true;
  }

  for (let i = used; i < bubbles.length; i++) {
    bubbles[i].visible = false;
  }
}
