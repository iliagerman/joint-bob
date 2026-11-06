// The camera over a drawn sheet, in a 1920 x 1080 frame: the point of the sheet at the middle of
// the frame, how close it is, and a slight turn. Films and the Activity overview move it the same
// way: gliding between views, rising off the paper on a long move, and breathing while it holds.

export const WIDTH = 1920;
export const HEIGHT = 1080;

/** Where the camera is: the point of the sheet at the middle of the frame, how close, and a slight turn. */
export const view = (x, y, zoom, tilt = 0) => ({ x, y, zoom, tilt });
/** A view that fits a rectangle of the sheet, with a margin around it. */
export const frameRect = (x, y, w, h, margin = 0.06) => view(x + w / 2, y + h / 2, Math.min(WIDTH / (w * (1 + margin)), HEIGHT / (h * (1 + margin))));

const lerp = (a, b, t) => a + (b - a) * t;

/** The view `t` of the way from `a` to `b`. */
export function between(a, b, t) {
  const zoom = Math.exp(lerp(Math.log(a.zoom), Math.log(b.zoom), t));
  // Pushing in keeps the point it pushes towards gliding steadily to the middle; pulling out does the same for the point it leaves.
  const x = b.zoom >= a.zoom ? b.x - (1 - t) * (b.x - a.x) * (a.zoom / zoom) : a.x + t * (b.x - a.x) * (b.zoom / zoom);
  const y = b.zoom >= a.zoom ? b.y - (1 - t) * (b.y - a.y) * (a.zoom / zoom) : a.y + t * (b.y - a.y) * (b.zoom / zoom);
  // A long move rises off the paper and comes down again, so the eye can follow where it goes.
  const travel = (Math.hypot(b.x - a.x, b.y - a.y) * Math.min(a.zoom, b.zoom)) / WIDTH;
  const hop = Math.max(0, travel - 0.45) * 0.8;
  return { x, y, zoom: zoom / (1 + hop * Math.sin(Math.PI * t)), tilt: lerp(a.tilt ?? 0, b.tilt ?? 0, t) };
}

/** A hand-held drift, so a held shot breathes. */
export const drift = (at, frame) => ({ x: at.x + (Math.sin(frame / 37) * 5 + Math.sin(frame / 13) * 1.2) / at.zoom, y: at.y + (Math.sin(frame / 29) * 4) / at.zoom, zoom: at.zoom * (1 + Math.sin(frame / 61) * 0.004), tilt: at.tilt + Math.sin(frame / 53) * 0.0025 });

/** Where a point of the sheet lands in the frame, seen from `at`. */
export function project(at, [x, y]) {
  const dx = (x - at.x) * at.zoom;
  const dy = (y - at.y) * at.zoom;
  return { x: WIDTH / 2 + dx * Math.cos(at.tilt) - dy * Math.sin(at.tilt), y: HEIGHT / 2 + dx * Math.sin(at.tilt) + dy * Math.cos(at.tilt) };
}
