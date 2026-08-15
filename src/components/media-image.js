import { createImageTexture } from "../utils/media-utils";
import { createBasisTexture, createKTX2Texture } from "../utils/create-basis-texture";
import { TextureCache } from "../utils/texture-cache";
import { errorTexture } from "../utils/error-texture";
import { createPlaneBufferGeometry } from "../utils/three-utils";
import { scaleToAspectRatio } from "../utils/scale-to-aspect-ratio";
import { createGIFTexture } from "../utils/gif-texture";
import { Layers } from "../camera-layers";

const textureCache = new TextureCache();
const inflightTextures = new Map();

const errorCacheItem = { texture: errorTexture, ratio: 1400 / 1200 };

AFRAME.registerComponent("media-image", {
  schema: {
    src: { type: "string" },
    version: { type: "number" },
    projection: { type: "string", default: "flat" },
    contentType: { type: "string" },
    alphaMode: { type: "string", default: undefined },
    alphaCutoff: { type: "number" }
  },

  play() {
    this.el.components["listed-media"] && this.el.sceneEl.emit("listed_media_changed");
  },

  remove() {
    if (this._retainedKey) {
      textureCache.release(this._retainedKey.src, this._retainedKey.version);
      this._retainedKey = null;
    }
  },

  async update(oldData) {
    let texture;
    let ratio = 1;

    // vegamix: the stock version nulled material.map up front (white flash for
    // the whole reload, permanent white on a failed reload) and released the
    // old texture before the new one existed. Instead we keep showing the old
    // texture and swap+release only when the replacement is ready.
    const prevRetainedKey = this._retainedKey;

    try {
      const { src, version, contentType } = this.data;
      if (!src) return;

      this.el.emit("image-loading");

      let cacheItem;
      if (textureCache.has(src, version)) {
        if (prevRetainedKey && prevRetainedKey.src === src && prevRetainedKey.version === version) {
          cacheItem = textureCache.get(src, version);
        } else {
          cacheItem = textureCache.retain(src, version);
        }
      } else {
        const inflightKey = TextureCache.key(src, version);

        if (src === "error") {
          cacheItem = errorCacheItem;
        } else if (inflightTextures.has(inflightKey)) {
          await inflightTextures.get(inflightKey);
          cacheItem = textureCache.retain(src, version);
        } else {
          let promise;
          if (contentType.includes("image/gif")) {
            promise = createGIFTexture(src);
          } else if (contentType.includes("image/basis")) {
            promise = createBasisTexture(src);
          } else if (contentType.includes("image/ktx2")) {
            promise = createKTX2Texture(src);
          } else if (contentType.startsWith("image/")) {
            promise = createImageTexture(src);
          } else {
            throw new Error(`Unknown image content type: ${contentType}`);
          }
          inflightTextures.set(inflightKey, promise);
          texture = await promise;
          inflightTextures.delete(inflightKey);
          cacheItem = textureCache.set(src, version, texture);
        }

        // No way to cancel promises, so if src has changed or this entity was removed while we were creating the texture just throw it away.
        if (this.data.src !== src || this.data.version !== version || !this.el.parentNode) {
          textureCache.release(src, version);
          return;
        }
      }

      texture = cacheItem.texture;
      ratio = cacheItem.ratio;

      this._retainedKey = src === "error" ? null : { src, version };
      this.currentSrcIsRetained = !!this._retainedKey;
    } catch (e) {
      console.error("Error loading image", this.data.src, e);
      texture = errorTexture;
      this._retainedKey = null;
      this.currentSrcIsRetained = false;
    }

    // Release the previously shown texture now that its replacement is in hand.
    if (
      prevRetainedKey &&
      !(this._retainedKey && prevRetainedKey.src === this._retainedKey.src && prevRetainedKey.version === this._retainedKey.version)
    ) {
      textureCache.release(prevRetainedKey.src, prevRetainedKey.version);
    }

    const projection = this.data.projection;

    if (!this.mesh || projection !== oldData.projection) {
      const material = new THREE.MeshBasicMaterial();
      material.toneMapped = false;

      let geometry;

      if (projection === "360-equirectangular") {
        geometry = new THREE.SphereBufferGeometry(1, 64, 32);
        // invert the geometry on the x-axis so that all of the faces point inward
        geometry.scale(-1, 1, 1);

        // Flip uvs on the geometry
        if (!texture.flipY) {
          const uvs = geometry.attributes.uv.array;

          for (let i = 1; i < uvs.length; i += 2) {
            uvs[i] = 1 - uvs[i];
          }
        }
      } else {
        geometry = createPlaneBufferGeometry(1, 1, 1, 1, texture.flipY);
        material.side = THREE.DoubleSide;
      }

      this.mesh = new THREE.Mesh(geometry, material);
      this.mesh.layers.set(Layers.CAMERA_LAYER_FX_MASK);
      this.el.setObject3D("mesh", this.mesh);
      this.meshFlipY = texture.flipY;
    } else if (projection === "flat" && this.meshFlipY !== texture.flipY) {
      // vegamix: the plane's UVs were built for the previous texture's flipY.
      // Swapping in a texture with the other orientation (e.g. error <-> real
      // image) rendered upside down — rebuild the geometry to match.
      const oldGeometry = this.mesh.geometry;
      this.mesh.geometry = createPlaneBufferGeometry(1, 1, 1, 1, texture.flipY);
      oldGeometry.dispose();
      this.meshFlipY = texture.flipY;
    }

    if (texture == errorTexture) {
      this.mesh.material.transparent = true;
    } else {
      // if transparency setting isnt explicitly defined, default to on for all gifs, and basis textures with alpha
      switch (this.data.alphaMode) {
        case "opaque":
          this.mesh.material.transparent = false;
          break;
        case "mask":
          this.mesh.material.transparent = false;
          this.mesh.material.alphaTest = this.data.alphaCutoff;
          break;
        case "blend":
        default:
          this.mesh.material.transparent = true;
          this.mesh.material.alphaTest = 0;
      }
    }

    this.mesh.material.map = texture;
    this.mesh.material.needsUpdate = true;

    if (projection === "flat") {
      scaleToAspectRatio(this.el, ratio);
    }

    this.el.emit("image-loaded", { src: this.data.src, projection: projection });
  }
});
