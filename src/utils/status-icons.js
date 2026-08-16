import { STATUS_COLORS } from "./user-status";

// Status glyphs are painted into a canvas rather than shipped as image assets:
// the nametag font is MSDF and has no emoji glyphs, and a canvas keeps the icon
// and its colour ring in one place with no new binaries in the repo.
const STATUS_GLYPHS = {
  none: "🙂",
  work: "💼",
  eat: "🍔",
  thinking: "💭",
  afk: "💤"
};

const ICON_PIXELS = 128;
const textureByStatus = new Map();

export function getStatusIconTexture(status) {
  const glyph = STATUS_GLYPHS[status];
  if (!glyph) return null;
  if (textureByStatus.has(status)) return textureByStatus.get(status);

  const canvas = document.createElement("canvas");
  canvas.width = ICON_PIXELS;
  canvas.height = ICON_PIXELS;
  const context = canvas.getContext("2d");
  const centre = ICON_PIXELS / 2;

  context.fillStyle = STATUS_COLORS[status] || "#ffffff";
  context.beginPath();
  context.arc(centre, centre, centre - 4, 0, Math.PI * 2);
  context.fill();

  context.font = `${Math.round(ICON_PIXELS * 0.55)}px sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(glyph, centre, centre + ICON_PIXELS * 0.04);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  textureByStatus.set(status, texture);
  return texture;
}
