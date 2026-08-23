import { hasReticulumServer } from "./phoenix-utils";
import configs from "./configs";
import isMobile from "./is-mobile";

const nonCorsProxyDomains = (configs.NON_CORS_PROXY_DOMAINS || "").split(",");
if (configs.CORS_PROXY_SERVER) {
  nonCorsProxyDomains.push(configs.CORS_PROXY_SERVER.split(":")[0]);
}
nonCorsProxyDomains.push(document.location.hostname);

const commonKnownContentTypes = {
  gltf: "model/gltf",
  glb: "model/gltf-binary",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  pdf: "application/pdf",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  basis: "image/basis",
  ktx2: "image/ktx2",
  m3u8: "application/vnd.apple.mpegurl",
  mpd: "application/dash+xml"
};

// thanks to https://developer.mozilla.org/en-US/docs/Web/API/WindowBase64/Base64_encoding_and_decoding
function b64EncodeUnicode(str) {
  // first we use encodeURIComponent to get percent-encoded UTF-8, then we convert the percent-encodings
  // into raw bytes which can be fed into btoa.
  const CHAR_RE = /%([0-9A-F]{2})/g;
  return btoa(encodeURIComponent(str).replace(CHAR_RE, (_, p1) => String.fromCharCode("0x" + p1)));
}

const farsparkEncodeUrl = url => {
  // farspark doesn't know how to read '=' base64 padding characters
  // translate base64 + to - and / to _ for URL safety
  return b64EncodeUnicode(url).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
};

// vegamix: media pinned in a room is served at whatever resolution it was uploaded at,
// which for phone photos means 5000+ px and tens of megabytes on every single join.
// Route still images through imgproxy so the client only ever fetches a bounded version.
// Same-origin on purpose: no CORS, no extra certificate, no config plumbing.
const IMAGE_RESIZE_PATH = "/_imgproxy";
const MAX_IMAGE_DIMENSION_DESKTOP = 2048;
const MAX_IMAGE_DIMENSION_MOBILE = 1024;
// Quality is a WebP quality, not a JPEG one — 82 is visually clean at these sizes.
const RESIZED_IMAGE_QUALITY = 82;

// imgproxy takes the source URL base64url-encoded, which keeps access tokens and
// query strings intact without any escaping games.
const imgproxyEncodeUrl = url => b64EncodeUnicode(url).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");

export const maxImageDimension = () => (isMobile() ? MAX_IMAGE_DIMENSION_MOBILE : MAX_IMAGE_DIMENSION_DESKTOP);

/**
 * Rewrites an image URL to a size-bounded, WebP-encoded version served by imgproxy.
 * Returns the URL untouched when rewriting does not apply, so callers can pass anything.
 */
// rs:fit bounds both axes while preserving aspect; the trailing 0 stops imgproxy
// from upscaling images that are already smaller than the budget. Returns null when
// the URL is not something we can rewrite, so callers keep their own fallback.
const imgproxyUrlFor = (url, width, height) => {
  if (typeof url !== "string") return null;
  // Blob and data URLs are already local, and "error" is the sentinel for the error texture.
  if (!(url.startsWith("http:") || url.startsWith("https:"))) return null;
  // Never re-wrap something we already wrapped.
  if (url.includes(`${IMAGE_RESIZE_PATH}/`)) return null;

  try {
    return (
      `${IMAGE_RESIZE_PATH}/insecure/rs:fit:${Math.round(width)}:${Math.round(height)}:0/` +
      `q:${RESIZED_IMAGE_QUALITY}/${imgproxyEncodeUrl(url)}.webp`
    );
  } catch (e) {
    console.warn("Could not build a resized image URL, falling back to the original.", e);
    return null;
  }
};

// Models get the same treatment as images, for the same reason and with bigger
// numbers: a pinned Sketchfab model is almost entirely texture, and Spoke rebuilds
// the scene as uncompressed geometry on every publish. Sending them through a proxy
// rather than optimising files by hand means a re-published scene is compressed
// automatically and pinned models never have to be replaced.
const MODEL_OPTIMIZE_PATH = "/_gltfproxy";

// Only content that was uploaded or fetched for a room. Assets that ship with the app
// (camera tool, waypoint preview, loading object, UI sounds) are already optimised by
// the build, and routing them through the proxy would only add a hop to every join.
const isRoomContentUrl = url => {
  if (typeof url !== "string") return false;
  if (!(url.startsWith("http:") || url.startsWith("https:"))) return false;
  // Never re-wrap something we already wrapped.
  if (url.includes(`${MODEL_OPTIMIZE_PATH}/`)) return false;

  try {
    const parsed = new URL(url, document.location.href);
    return (
      parsed.pathname.startsWith("/files/") ||
      (!!configs.CORS_PROXY_SERVER && parsed.host === configs.CORS_PROXY_SERVER.split("/")[0])
    );
  } catch {
    return false;
  }
};

/**
 * Rewrites an audio URL to a lower-bitrate mono version served by gltfproxy.
 *
 * A pinned track is served at whatever bitrate it was uploaded at - the one in the
 * office room was 320 kbps stereo, 12.3 MB, and every join pulled all of it through
 * range requests. Returns the URL unchanged when rewriting does not apply.
 */
export const optimizedAudioUrlFor = url => {
  if (!isRoomContentUrl(url)) return url;
  try {
    return `${MODEL_OPTIMIZE_PATH}/audio/${imgproxyEncodeUrl(url)}.mp3`;
  } catch (e) {
    console.warn("Could not build an optimized audio URL, falling back to the original.", e);
    return url;
  }
};

/**
 * Rewrites a model URL to a compressed .glb served by gltfproxy, or returns it
 * unchanged when rewriting does not apply.
 */
export const optimizedModelUrlFor = url => {
  if (!isRoomContentUrl(url)) return url;

  try {
    return `${MODEL_OPTIMIZE_PATH}/optimize/${imgproxyEncodeUrl(url)}.glb`;
  } catch (e) {
    console.warn("Could not build an optimized model URL, falling back to the original.", e);
    return url;
  }
};

export const resizedImageUrlFor = url => {
  const dimension = maxImageDimension();
  return imgproxyUrlFor(url, dimension, dimension) || url;
};

export const scaledThumbnailUrlFor = (url, width, height) => {
  let extension = "";
  try {
    const pathParts = new URL(url).pathname.split(".");

    if (pathParts.length > 1) {
      const extensionCandidate = pathParts.pop();
      if (commonKnownContentTypes[extensionCandidate]) {
        extension = `.${extensionCandidate}`;
      }
    }
  } catch (e) {
    console.warn("couldn't determine thumbnail media type, falling back to png. ", e);
    extension = ".png";
  }

  // HACK: the extension is needed to ensure CDN caching on Cloudflare
  const thumbnailUrl = `https://${configs.THUMBNAIL_SERVER}/thumbnail/${farsparkEncodeUrl(
    url
  )}${extension}?w=${width}&h=${height}`;

  try {
    const urlHostname = new URL(url).hostname;

    if (hasReticulumServer()) {
      const retHostname = new URL(`https://${configs.RETICULUM_SERVER}`).hostname;
      if (retHostname === urlHostname) {
        // vegamix: our own files used to be handed back at full size here, so the avatar
        // and scene browsers were downloading multi-megabyte originals as thumbnails
        // (35 avatars cost 65 MB per visit). imgproxy is same-origin, so use it instead.
        return imgproxyUrlFor(url, width, height) || url;
      }
    }
  } catch (e) {
    console.warn("couldn't parse server URL ", e);
    return thumbnailUrl;
  }

  return thumbnailUrl;
};

export const isNonCorsProxyDomain = hostname => {
  return nonCorsProxyDomains.find(domain => hostname.endsWith(domain));
};

export const proxiedUrlFor = url => {
  if (!(url.startsWith("http:") || url.startsWith("https:"))) return url;

  // Skip known domains that do not require CORS proxying.
  try {
    const parsedUrl = new URL(url);
    if (isNonCorsProxyDomain(parsedUrl.hostname)) return url;
  } catch {
    // Ignore
  }

  return `https://${configs.CORS_PROXY_SERVER}/${url}`;
};

export function getAbsoluteUrl(baseUrl, relativeUrl) {
  return new URL(relativeUrl, baseUrl);
}

export function getAbsoluteHref(baseUrl, relativeUrl) {
  return getAbsoluteUrl(baseUrl, relativeUrl).href;
}

// Note these files are configured in webpack.config.js to be handled with file-loader, so this will be a string containing the file paths
import basisJsUrl from "three/examples/js/libs/basis/basis_transcoder.js";
import dracoWrapperJsUrl from "three/examples/js/libs/draco/gltf/draco_wasm_wrapper.js";
import basisWasmUrl from "three/examples/js/libs/basis/basis_transcoder.wasm";
import dracoWasmUrl from "three/examples/js/libs/draco/gltf/draco_decoder.wasm";

export const rewriteBasisTranscoderUrls = function (url) {
  if (url === "basis_transcoder.js") {
    return basisJsUrl;
  } else if (url === "basis_transcoder.wasm") {
    return basisWasmUrl;
  }
  return url;
};

export const getCustomGLTFParserURLResolver = gltfUrl => url => {
  // Intercept loading of basis transcoder with content hashed urls
  if (url === "basis_transcoder.js") {
    return basisJsUrl;
  } else if (url === "basis_transcoder.wasm") {
    return basisWasmUrl;
  } else if (url === "draco_wasm_wrapper.js") {
    return dracoWrapperJsUrl;
  } else if (url === "draco_decoder.wasm") {
    return dracoWasmUrl;
  }

  if (typeof url !== "string" || url === "") return "";
  if (/^(https?:)?\/\//i.test(url)) {
    // vegamix: an avatar's maps are external resources of its .gltf rather than part
    // of the file, so they never passed through the texture loaders we route. They
    // arrive at 1-1.5 MB each and a room full of people pays for every one of them.
    // Buffers still have to be fetched whole - imgproxy only understands images.
    if (/\.(png|jpe?g|webp)(\?|$)/i.test(url)) {
      return resizedImageUrlFor(proxiedUrlFor(url));
    }
    return proxiedUrlFor(url);
  }
  if (/^data:.*,.*$/i.test(url)) return url;
  if (/^blob:.*$/i.test(url)) return url;

  if (configs.CORS_PROXY_SERVER) {
    // For absolute paths with a CORS proxied gltf URL, re-write the url properly to be proxied
    const corsProxyPrefix = `https://${configs.CORS_PROXY_SERVER}/`;

    if (gltfUrl.startsWith(corsProxyPrefix)) {
      const originalUrl = decodeURIComponent(gltfUrl.substring(corsProxyPrefix.length));
      const originalUrlParts = originalUrl.split("/");

      // Drop the .gltf filename
      const path = new URL(url).pathname;
      const assetUrl = originalUrlParts.slice(0, originalUrlParts.length - 1).join("/") + "/" + path;
      return corsProxyPrefix + assetUrl;
    }
  }

  return url;
};

const dataUrlRegex = /data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+).*,.*/;

export const guessContentType = url => {
  if (!url) return;
  if (url.startsWith("hubs://") && url.endsWith("/video")) return "video/vnd.hubs-webrtc";
  if (url.startsWith("data:")) {
    const matches = dataUrlRegex.exec(url);
    if (matches.length > 0) {
      matches[1];
    }
  }
  const extension = new URL(url, window.location).pathname.split(".").pop();
  return commonKnownContentTypes[extension];
};

// Hosts that serve bytes and never serve a room. Asking one of them whether it
// is a Hubs server means a HEAD on its root, which answers 404 without a CORS
// header, so the answer we already know costs a failed request in the console
// on every room load. The page's own origin is deliberately not in here:
// BASE_ASSETS_PATH resolves to it when assets come from the same host, and
// isLocalHubsUrl needs the real answer for that one.
const knownNonHubsOrigins = (() => {
  const origins = new Set();
  for (const hostOrUrl of [
    configs.BASE_ASSETS_PATH,
    configs.THUMBNAIL_SERVER,
    configs.CORS_PROXY_SERVER,
    configs.UPLOADS_HOST
  ]) {
    if (!hostOrUrl) continue;
    try {
      origins.add(new URL(hostOrUrl.startsWith("http") ? hostOrUrl : `https://${hostOrUrl}`).origin);
    } catch {
      // Ignore
    }
  }
  origins.delete(document.location.origin);
  return origins;
})();

const originIsHubsServer = new Map();
async function isHubsServer(url) {
  if (!url) return false;
  if (!url.startsWith("http")) {
    url = "https://" + url;
  }
  const { origin } = new URL(url);

  if (knownNonHubsOrigins.has(origin)) return false;

  if (originIsHubsServer.has(origin)) {
    return originIsHubsServer.get(origin);
  }

  let isHubsServer;
  try {
    isHubsServer = (await fetch(proxiedUrlFor(origin), { method: "HEAD" })).headers.has("hub-name");
  } catch (e) {
    console.warn("couldn't fetch hubs server ", e);
    isHubsServer = false;
  }
  originIsHubsServer.set(origin, isHubsServer);
  return isHubsServer;
}

const hubsSceneRegex = /https?:\/\/[^/]+\/scenes\/[a-zA-Z0-9]{7}(?:\/|$)/;
const hubsAvatarRegex = /https?:\/\/[^/]+\/avatars\/(?<id>[a-zA-Z0-9]{7})(?:\/|$)/;
export const hubsRoomRegex = /(https?:\/\/)?[^/]+\/(?<id>[a-zA-Z0-9]{7})(?:\/|$)/;
export const localHubsRoomRegex = /https?:\/\/[^/]+\/hub\.html\?hub_id=(?<id>[a-zA-Z0-9]{7})/;

export const isLocalHubsUrl = async url =>
  (await isHubsServer(url)) && new URL(url).origin === document.location.origin;

export const isHubsSceneUrl = async url => (await isHubsServer(url)) && hubsSceneRegex.test(url);
export const isLocalHubsSceneUrl = async url => (await isHubsSceneUrl(url)) && (await isLocalHubsUrl(url));

export const isHubsAvatarUrl = async url => (await isHubsServer(url)) && hubsAvatarRegex.test(url);
export const isLocalHubsAvatarUrl = async url => (await isHubsAvatarUrl(url)) && (await isLocalHubsUrl(url));

export const hubIdFromUrl = url => url.match(hubsRoomRegex)?.groups.id || url.match(localHubsRoomRegex)?.groups.id;

export const isHubsRoomUrl = async url =>
  (await isHubsServer(url)) && !(await isHubsAvatarUrl(url)) && !(await isHubsSceneUrl(url)) && hubIdFromUrl(url);

export const isHubsDestinationUrl = async url =>
  (await isHubsServer(url)) && ((await isHubsSceneUrl(url)) || (await isHubsRoomUrl(url)));

export const idForAvatarUrl = url => {
  const match = url.match(hubsAvatarRegex);
  if (match) {
    return match.groups.id;
  }
  return null;
};
