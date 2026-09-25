export function recognizeCreationStroke(points) {
  if (points.length < 12) return null;
  const left = Math.min(...points.map(p => p.x)), top = Math.min(...points.map(p => p.y));
  const width = Math.max(...points.map(p => p.x)) - left, height = Math.max(...points.map(p => p.y)) - top;
  if (width < 70 || height < 70 || width / height < 0.4 || width / height > 2) return null;
  const normalized = points.map(p => ({ x: (p.x - left) / width, y: (p.y - top) / height }));
  if (isCapitalN(normalized)) return "note";
  if (isOpenC(normalized)) return "conversation";
  return null;
}

function isCapitalN(points) {
  const start = points[0], end = points.at(-1);
  if (start.x > 0.2 || start.y < 0.8 || end.x < 0.8 || end.y > 0.2) return false;
  // Recognize two broad vertical turns, allowing curved and slanted sides.
  let segment = 0, peak = start, valley = start, rightmost = start.x, travel = 0;
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (p.x < rightmost - 0.12) return false;
    rightmost = Math.max(rightmost, p.x);
    travel += Math.abs(p.y - points[i - 1].y);
    if (segment === 0) {
      if (p.y < peak.y) peak = p;
      if (p.y - peak.y > 0.3) {
        if (peak.y > 0.3) return false;
        segment = 1; valley = p;
      }
    } else if (segment === 1) {
      if (p.y > valley.y) valley = p;
      if (valley.y - p.y > 0.3) {
        if (valley.y < 0.7 || valley.x - peak.x < 0.08) return false;
        segment = 2;
      }
    }
  }
  return segment === 2 && travel < 3.6;
}

function isOpenC(points) {
  const start = points[0], end = points.at(-1);
  if (start.x < 0.8 || end.x < 0.8 || Math.abs(start.y - end.y) < 0.6) return false;
  let rotation = 0, travel = 0, previous = Math.atan2(start.y - 0.5, start.x - 0.5);
  for (const p of points.slice(1)) {
    if (Math.hypot(p.x - 0.5, p.y - 0.5) < 0.3) return false;
    const angle = Math.atan2(p.y - 0.5, p.x - 0.5);
    const delta = Math.atan2(Math.sin(angle - previous), Math.cos(angle - previous));
    rotation += delta; travel += Math.abs(delta); previous = angle;
  }
  return Math.abs(rotation) > 3.8 && Math.abs(rotation) < 5.7 && Math.abs(rotation) > travel * 0.9;
}

export function installCreationGestures(createConversation, createNote) {
  let stroke = null;
  const enabled = () => matchMedia("(max-width: 700px)").matches && document.body.classList.contains("focus-ui") && !document.querySelector("dialog[open]");
  document.addEventListener("touchstart", event => {
    stroke = null;
    if (!enabled() || event.touches.length !== 1 || event.target.closest("button:not(.session-card):not(.project-card),input,textarea,select,a,summary,label,[contenteditable],#browserPanel,.xterm,.canvas-root")) return;
    const touch = event.touches[0];
    stroke = { id: touch.identifier, started: performance.now(), points: [{ x: touch.clientX, y: touch.clientY }] };
  }, { passive: true });
  document.addEventListener("touchmove", event => {
    if (!stroke) return;
    if (event.touches.length !== 1 || stroke.points.length >= 512 || performance.now() - stroke.started > 3000) { stroke = null; return; }
    const touch = event.touches[0];
    if (touch.identifier === stroke.id) stroke.points.push({ x: touch.clientX, y: touch.clientY });
  }, { passive: true });
  document.addEventListener("touchend", () => {
    const completed = stroke;
    stroke = null;
    if (!completed || !enabled() || performance.now() - completed.started > 3000) return;
    const gesture = recognizeCreationStroke(completed.points);
    if (gesture === "conversation") createConversation();
    if (gesture === "note") createNote();
  }, { passive: true });
  document.addEventListener("touchcancel", () => { stroke = null; }, { passive: true });
}
