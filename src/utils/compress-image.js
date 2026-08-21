// vegamix: photos straight off a phone are 20-30 MB and 5000+ px wide. Pinned in a room
// they cost that much on every join, plus ~80 MB of RGBA in video memory each. Downscale
// and re-encode before upload so the heavy original never reaches storage at all.
//
// Deliberately avoids decoding the full-resolution image: a 50 MP photo would be ~200 MB
// as an ImageBitmap, which is the memory spike we are trying to get rid of. Instead the
// dimensions and EXIF orientation come out of the file header, and createImageBitmap is
// asked to decode straight to the target size in one pass.

const MAX_DIMENSION = 2048;
// Below this, re-encoding buys little and risks making the file bigger.
const MIN_BYTES = 512 * 1024;
const JPEG_QUALITY = 0.85;

const COMPRESSIBLE_TYPES = ["image/jpeg", "image/png", "image/webp"];

// Orientations 5-8 rotate by 90 degrees, so stored width/height are swapped
// relative to how the image is displayed.
const SWAPS_AXES = [5, 6, 7, 8];

function readPngHeader(view) {
  // PNG signature, then IHDR: width and height at byte 16, colour type at byte 25.
  if (view.byteLength < 26) return null;
  if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) return null;
  const colorType = view.getUint8(25);
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    // Colour types 4 (grey+alpha) and 6 (RGBA) carry transparency we must not flatten.
    hasAlpha: colorType === 4 || colorType === 6,
    orientation: 1
  };
}

function readExifOrientation(view, start, length) {
  try {
    // "Exif\0\0" then a TIFF header whose first two bytes give the byte order.
    if (view.getUint32(start) !== 0x45786966) return null;

    const tiff = start + 6;
    const little = view.getUint16(tiff) === 0x4949;
    const ifdOffset = view.getUint32(tiff + 4, little);
    const ifd = tiff + ifdOffset;
    if (ifd + 2 > start + length) return null;

    const entryCount = view.getUint16(ifd, little);
    for (let i = 0; i < entryCount; i++) {
      const entry = ifd + 2 + i * 12;
      if (entry + 12 > view.byteLength) return null;
      if (view.getUint16(entry, little) === 0x0112) {
        return view.getUint16(entry + 8, little);
      }
    }
  } catch {
    // A truncated or malformed EXIF block is not worth failing an upload over.
  }
  return null;
}

function readJpegHeader(view) {
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;

  let offset = 2;
  let orientation = 1;

  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) {
      offset++;
      continue;
    }

    const marker = view.getUint8(offset + 1);

    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }

    const segmentLength = view.getUint16(offset + 2);

    // APP1 holds the EXIF block, which is where the orientation tag lives.
    if (marker === 0xe1 && offset + 10 <= view.byteLength) {
      orientation = readExifOrientation(view, offset + 4, segmentLength - 2) || orientation;
    }

    // Start-of-frame markers hold the real dimensions. 0xC4/0xC8/0xCC are not frames.
    const isFrameMarker = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isFrameMarker) {
      if (offset + 9 > view.byteLength) return null;
      return {
        height: view.getUint16(offset + 5),
        width: view.getUint16(offset + 7),
        hasAlpha: false,
        orientation
      };
    }

    offset += 2 + segmentLength;
  }

  return null;
}

async function readHeader(file) {
  // 128 KB comfortably covers a PNG IHDR and a JPEG's EXIF block plus frame header.
  const buffer = await file.slice(0, 128 * 1024).arrayBuffer();
  const view = new DataView(buffer);
  return readPngHeader(view) || readJpegHeader(view);
}

function encode(canvas, type, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

/**
 * Downscale and re-encode an image chosen for upload. Returns the original File
 * untouched if it is already small enough, is not a still image, or if anything
 * about the conversion fails — an upload that works beats one that is optimal.
 */
export async function compressImageForUpload(file) {
  if (!file || !COMPRESSIBLE_TYPES.includes(file.type)) return file;
  if (typeof createImageBitmap !== "function") return file;

  try {
    const header = await readHeader(file);

    // WebP has no parser here, so fall back to letting the browser tell us the size.
    let { width, height, hasAlpha, orientation } = header || {};

    if (!header) {
      if (file.type !== "image/webp") return file;
      const probe = await createImageBitmap(file, { imageOrientation: "from-image" });
      width = probe.width;
      height = probe.height;
      hasAlpha = true;
      orientation = 1;
      probe.close();
    }

    if (!width || !height) return file;

    if (SWAPS_AXES.includes(orientation)) {
      [width, height] = [height, width];
    }

    const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));

    // Already within budget and not oversized on disk — leave it alone.
    if (scale === 1 && file.size < MIN_BYTES) return file;

    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));

    const bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
      resizeWidth: targetWidth,
      resizeHeight: targetHeight,
      resizeQuality: "high"
    });

    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;

    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    // Flattening an image with transparency onto white would be a visible change,
    // so those stay PNG. Everything else becomes JPEG, which is where the win is.
    const outputType = hasAlpha ? "image/png" : "image/jpeg";
    const blob = await encode(canvas, outputType, JPEG_QUALITY);

    // Release the backing store now rather than waiting for GC.
    canvas.width = canvas.height = 0;

    if (!blob || blob.size >= file.size) return file;

    const extension = outputType === "image/png" ? "png" : "jpg";
    const name = file.name.replace(/\.[^.]+$/, "") + "." + extension;

    console.log(
      `Compressed ${file.name} for upload: ${width}x${height} ${(file.size / 1048576).toFixed(1)} MB -> ` +
        `${targetWidth}x${targetHeight} ${(blob.size / 1048576).toFixed(1)} MB`
    );

    return new File([blob], name, { type: outputType, lastModified: file.lastModified });
  } catch (e) {
    console.warn("Image compression failed, uploading the original.", e);
    return file;
  }
}
