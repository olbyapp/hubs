import { STATUS_COLORS } from "./user-status";
import { PRIVATE_ZONE_COLOR } from "./private-zone";

// Status glyphs are painted into a canvas rather than shipped as image assets:
// the nametag font is MSDF and has no emoji glyphs, and a canvas keeps the icon
// and its colour ring in one place with no new binaries in the repo.
// Exported because the video tiles draw the same glyph in the DOM, where the
// MSDF limitation does not apply but the icon should still read as one signal.
export const STATUS_GLYPHS = {
  none: "🙂",
  work: "💼",
  eat: "🍔",
  thinking: "💭",
  afk: "💤"
};

// Same treatment for "this person is in a private zone".
export const PRIVATE_ZONE_GLYPH = "👂";

const ICON_PIXELS = 128;
const textureByKey = new Map();

function getGlyphTexture(key, glyph, color) {
  if (!glyph) return null;
  if (textureByKey.has(key)) return textureByKey.get(key);

  const canvas = document.createElement("canvas");
  canvas.width = ICON_PIXELS;
  canvas.height = ICON_PIXELS;
  const context = canvas.getContext("2d");
  const centre = ICON_PIXELS / 2;

  context.fillStyle = color || "#ffffff";
  context.beginPath();
  context.arc(centre, centre, centre - 4, 0, Math.PI * 2);
  context.fill();

  context.font = `${Math.round(ICON_PIXELS * 0.55)}px sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(glyph, centre, centre + ICON_PIXELS * 0.04);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  textureByKey.set(key, texture);
  return texture;
}

export function getStatusIconTexture(status) {
  return getGlyphTexture(`status:${status}`, STATUS_GLYPHS[status], STATUS_COLORS[status]);
}

export function getPrivateZoneIconTexture() {
  return getGlyphTexture("private-zone", PRIVATE_ZONE_GLYPH, PRIVATE_ZONE_COLOR);
}
