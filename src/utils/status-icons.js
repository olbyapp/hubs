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

// "This person's tab is in the background." Shared with the People panel so the
// two places that show it cannot drift apart.
//
// The variation selector is load-bearing: U+1F441 has Emoji_Presentation=No, so on
// its own a canvas paints it as a thin monochrome outline that vanished against the
// icon's grey disc. U+FE0F forces the emoji form. The DOM in the People panel picked
// a colour font by itself, which is why it looked fine there and blank on the tag.
export const AWAY_GLYPH = "👁️";

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

// The away icon is drawn differently from the status and private-zone ones: no
// coloured disc, and cut to the glyph's real bounding box. It sits in front of the
// name rather than in the icon row, so it should read as a small mark next to the
// text, not as another badge competing with it.
//
// The bounding box also fixes the centring. Painting an emoji at the middle of a
// square canvas assumes the font puts it there, and Android's emoji font does not -
// the eye sat visibly high in its circle. Measuring puts it right on every platform.
const AWAY_ICON_PIXELS = 96;
let awayIconTexture;

export function getAwayIconTexture() {
  if (awayIconTexture !== undefined) return awayIconTexture;

  const font = `${AWAY_ICON_PIXELS}px sans-serif`;
  const measuring = document.createElement("canvas").getContext("2d");
  measuring.font = font;
  const metrics = measuring.measureText(AWAY_GLYPH);

  // Not every browser fills these in; the font size is a fair stand-in.
  const ascent = Math.ceil(metrics.actualBoundingBoxAscent || AWAY_ICON_PIXELS * 0.8);
  const descent = Math.ceil(metrics.actualBoundingBoxDescent || AWAY_ICON_PIXELS * 0.1);
  const width = Math.max(1, Math.ceil(metrics.width));
  const height = Math.max(1, ascent + descent);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.font = font;
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  context.fillText(AWAY_GLYPH, 0, ascent);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  awayIconTexture = { texture, aspect: width / height };
  return awayIconTexture;
}

// Award icons for the name tag: the emoji a person holds, side by side, with
// no text at all. Painted into a canvas for the same reason the status glyphs
// are — the nametag font is MSDF and has no emoji — and drawn as one strip
// rather than one mesh per award so a name tag adds no draw calls per award.
//
// The canvas is cut to the glyphs' real bounding box rather than to the font
// size. An emoji sits well above the "middle" baseline, so a canvas centred
// the easy way carries a band of empty pixels underneath — which on the name
// tag read as the icons hugging the name with a gap below them.
const ACHIEVEMENT_ICON_PIXELS = 64;
const ACHIEVEMENT_ICON_FONT = `${ACHIEVEMENT_ICON_PIXELS}px sans-serif`;
const ACHIEVEMENT_ICON_GAP = 12;
const achievementIconTextures = new Map();

// Returns { texture, aspect } — aspect being width/height, so the caller can
// scale a unit plane to the strip's shape. Null when there are no awards.
export function getAchievementIconsTexture(emoji) {
  if (!emoji || !emoji.length) return null;
  const key = emoji.join("");
  if (achievementIconTextures.has(key)) return achievementIconTextures.get(key);

  const measuring = document.createElement("canvas").getContext("2d");
  measuring.font = ACHIEVEMENT_ICON_FONT;
  const measured = emoji.map(glyph => {
    const metrics = measuring.measureText(glyph);
    return {
      glyph,
      width: Math.ceil(metrics.width),
      // Not every browser fills these in; the font size is a fair stand-in.
      ascent: Math.ceil(metrics.actualBoundingBoxAscent || ACHIEVEMENT_ICON_PIXELS * 0.8),
      descent: Math.ceil(metrics.actualBoundingBoxDescent || ACHIEVEMENT_ICON_PIXELS * 0.1)
    };
  });

  const ascent = Math.max(...measured.map(m => m.ascent));
  const descent = Math.max(...measured.map(m => m.descent));
  const height = ascent + descent;
  const width = measured.reduce((total, each) => total + each.width, 0) + ACHIEVEMENT_ICON_GAP * (emoji.length - 1);

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const context = canvas.getContext("2d");
  context.font = ACHIEVEMENT_ICON_FONT;
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  let x = 0;
  for (const each of measured) {
    context.fillText(each.glyph, x, ascent);
    x += each.width + ACHIEVEMENT_ICON_GAP;
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const entry = { texture, aspect: canvas.width / canvas.height };
  achievementIconTextures.set(key, entry);
  return entry;
}
