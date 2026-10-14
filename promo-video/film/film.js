// The film itself. `window.film.render(frame)` puts one exact frame on the page: it loads the
// recording frames the screens show, draws the 3D scene and lays the captions over it. The
// render script calls it once per frame and photographs the result. `?film=` names the film.
import * as THREE from "three";
import { films } from "./films.js";

const film = films[new URLSearchParams(location.search).get("film") ?? "teaser"];
const canvas = document.querySelector("#stage");
const picture = film.create(canvas, document.querySelector("#overlay"));

// `meta.json` is written by the capture; `manifest.json` by the render script, which also
// extracts the recording frames named in it.
const [meta, manifest] = await Promise.all([fetch("/public/captures/meta.json").then((response) => response.json()), fetch("/work/manifest.json").then((response) => response.json())]);
const loader = new THREE.TextureLoader();
const shown = {};

/** The texture for one screen. A screen holding the same picture keeps its texture. */
async function screenTexture({ screen, clip, index }) {
  if (clip === null || index === null) return null;
  const key = `${clip}/${index}`;
  if (shown[screen]?.key === key) return shown[screen].texture;
  const texture = await loader.loadAsync(`/work/frames/${key}.jpg`);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 16;
  shown[screen]?.texture.dispose();
  shown[screen] = { key, texture };
  return texture;
}

window.film = {
  duration: film.duration,
  renderer: () => {
    const context = picture.renderer.getContext();
    const info = context.getExtension("WEBGL_debug_renderer_info");
    return info ? context.getParameter(info.UNMASKED_RENDERER_WEBGL) : "unknown";
  },
  /** `out` counts the frames of this film; a cut plays another film's frames in its own order. */
  async render(out) {
    const frame = film.frameAt(out);
    const sources = film.sources(frame, meta, manifest.frames);
    const textures = await Promise.all(sources.map(screenTexture));
    picture.draw(frame, Object.fromEntries(sources.map((source, index) => [source.screen, textures[index]])), out);
    const blur = film.blurAt(frame);
    canvas.style.filter = blur > 0 ? `blur(${blur}px)` : "";
  },
};
