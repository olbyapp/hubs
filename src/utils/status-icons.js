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

// Achievement line for the name tag. Painted into a canvas for the same reason
// the status glyphs are — the nametag font is MSDF, so it has neither the emoji
// nor the Cyrillic the award labels are written in — but as a whole line
// rather than a badge, because the award replaces the pronouns text and has to
// read as text.
const ACHIEVEMENT_PIXELS_PER_LINE = 64;
const ACHIEVEMENT_FONT = `500 ${Math.round(ACHIEVEMENT_PIXELS_PER_LINE * 0.68)}px sans-serif`;
const ACHIEVEMENT_PADDING = 12;
const achievementTextures = new Map();

// Returns { texture, aspect } — aspect being width/height, so the caller can
// scale a unit plane to the shape the text actually came out as.
export function getAchievementTexture(line) {
  if (!line) return null;
  if (achievementTextures.has(line)) return achievementTextures.get(line);

  const measuring = document.createElement("canvas").getContext("2d");
  measuring.font = ACHIEVEMENT_FONT;
  const width = Math.ceil(measuring.measureText(line).width) + ACHIEVEMENT_PADDING * 2;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = ACHIEVEMENT_PIXELS_PER_LINE;
  const context = canvas.getContext("2d");
  context.font = ACHIEVEMENT_FONT;
  context.textAlign = "center";
  context.textBaseline = "middle";
  // The plate behind is only half opaque, so the line needs to survive being
  // read against a bright wall as well as against the plate.
  context.lineWidth = 4;
  context.strokeStyle = "rgba(0, 0, 0, 0.75)";
  context.strokeText(line, width / 2, ACHIEVEMENT_PIXELS_PER_LINE / 2);
  context.fillStyle = "#ffffff";
  context.fillText(line, width / 2, ACHIEVEMENT_PIXELS_PER_LINE / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const entry = { texture, aspect: width / ACHIEVEMENT_PIXELS_PER_LINE };
  achievementTextures.set(line, entry);
  return entry;
}
