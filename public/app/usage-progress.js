/**
 * One compact progress line in the dialog's header while a Costs view loads its reports: a bar,
 * how many parts are ready, which ones it is still waiting for, and the seconds spent so far.
 * It sits in the header so appearing and disappearing never moves the page below it.
 */

function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}

const MARKS = { done: "✓", failed: "✗", running: "…" };

/** `label: false` leaves the wording to a status line beside it; the line then shows only counts and parts. */
export function createProgress(host, { label = true } = {}) {
  host.classList.add("usage-progress");
  host.hidden = true;
  host.setAttribute("aria-live", "off");
  const title = label ? node("span", undefined, "usage-progress-label") : null;
  const track = node("span", undefined, "usage-progress-track");
  const fill = node("i");
  track.append(fill);
  const counter = node("span", undefined, "usage-progress-count");
  const waiting = node("span", undefined, "usage-progress-waiting");
  host.append(...[title, track, counter, waiting].filter(Boolean));
  let steps = [];
  let startedAt = 0;
  let timer = null;

  function draw() {
    const settled = steps.filter((step) => step.state !== "running");
    const running = steps.filter((step) => step.state === "running");
    const failed = steps.filter((step) => step.state === "failed");
    fill.style.width = `${steps.length ? Math.max(6, settled.length / steps.length * 100) : 0}%`;
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    counter.textContent = `${settled.length} of ${steps.length} ready${seconds >= 2 ? ` · ${seconds}s` : ""}`;
    const names = running.slice(0, 2).map((step) => step.name).join(", ") + (running.length > 2 ? ` +${running.length - 2}` : "");
    waiting.textContent = [running.length ? `waiting for ${names}` : "", failed.length ? `${failed.map((step) => step.name).join(", ")} failed` : ""].filter(Boolean).join(" · ");
    host.title = steps.map((step) => `${MARKS[step.state]} ${step.name}`).join("\n");
    host.dataset.state = running.length ? "running" : "done";
  }
  function stopTimer() { clearInterval(timer); timer = null; }

  return {
    /** Shows the line with every part waiting; `text` is the label when this line has one. */
    start(names, text = "Loading…") {
      steps = names.map(([key, name]) => ({ key, name, state: "running" }));
      startedAt = Date.now();
      if (title) title.textContent = text;
      host.hidden = !steps.length;
      draw();
      stopTimer();
      timer = setInterval(draw, 1000);
    },
    /** Marks one part done or failed; the line hides when nothing is left running. */
    mark(key, state = "done") {
      const step = steps.find((item) => item.key === key);
      if (!step || step.state === state) return;
      step.state = state;
      draw();
      if (steps.every((item) => item.state !== "running")) this.finish();
    },
    finish() { stopTimer(); host.hidden = true; },
    get running() { return !host.hidden; },
  };
}

/** Grey blocks that hold a panel's shape until its numbers arrive. */
export function skeleton(rows = 3, className = "") {
  const wrap = node("div", undefined, `usage-skeleton ${className}`.trim());
  wrap.setAttribute("aria-hidden", "true");
  for (let index = 0; index < rows; index++) {
    const line = node("i");
    line.style.width = `${[92, 78, 86, 70, 82][index % 5]}%`;
    wrap.append(line);
  }
  return wrap;
}
