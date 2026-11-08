// Slide 3 · Smart model selection, as a taxi rank from the future. A message walks up, the
// dispatcher scans it and judges its difficulty, and the cab sized for that level picks it up and
// leaves. An unsure judgement keeps the conversation in the cab it is already in.
const AGENTS = { c: "Claude Code", o: "Pi · OpenAI", k: "Kiro" };
const ROUTES = [
  { text: "Commit the fix and push it to main", level: 2, conf: 0.93, lane: "light", agent: "c", task: "Terminal and git work" },
  { text: "Add CSV export to the reports page, with tests", level: 6, conf: 0.86, lane: "standard", agent: "o", task: "Complex coding across several files" },
  { text: "What does the retryBudget flag do?", level: 1, conf: 0.95, lane: "light", agent: "o", task: "A question, answered by reading" },
  { text: "Checkout fails only in Safari. Find out why and fix it", level: 8, conf: 0.81, lane: "deep", agent: "c", task: "Debugging: reproduce, trace, fix" },
  { text: "hmm, maybe the other way?", level: 5, conf: 0.22, lane: null, agent: "k", task: "Unsure (22%, under 30%): stays in its current cab" },
  { text: "Rename userId to accountId in this file", level: 4, conf: 0.9, lane: "light", agent: "k", task: "Simple coding, one small change" },
  { text: "Plan the move to multi-region failover", level: 10, conf: 0.88, lane: "deep", agent: "o", task: "Planning: architecture and risk" },
];

/** Where an element sits inside `root`, in the stage's own pixels (offsets ignore the stage scale). */
function centerIn(el, root) {
  let x = el.offsetWidth / 2;
  let y = el.offsetHeight / 2;
  for (let node = el; node && node !== root; node = node.offsetParent) { x += node.offsetLeft; y += node.offsetTop; }
  return [x, y];
}

export default function dispatchScene(slide, { later }) {
  const root = slide.querySelector(".dispatch");
  const card = slide.querySelector("#promptCard");
  const text = slide.querySelector("#promptText");
  const who = card.querySelector(".who");
  const task = slide.querySelector("#taskText");
  const level = slide.querySelector("#levelNum");
  const conf = slide.querySelector("#confText");
  const segments = [...slide.querySelectorAll(".holo-bar i")];
  const bot = slide.querySelector(".tower");
  const eye = slide.querySelector("#botEye");
  const rider = slide.querySelector("#rider");
  const counts = { light: 0, standard: 0, deep: 0 };
  let n = 0;

  const look = (dx) => eye.setAttribute("transform", `translate(${dx} 0)`);
  const one = () => {
    const route = ROUTES[n % ROUTES.length];
    n += 1;
    card.classList.remove("out", "boarded");
    text.textContent = "";
    who.textContent = `Developer · ${AGENTS[route.agent]}`;
    task.classList.remove("on");
    level.textContent = "–";
    conf.textContent = "confidence –";
    segments.forEach((s) => s.classList.remove("on", "warm", "hot"));
    slide.querySelectorAll(".bay").forEach((bay) => bay.classList.remove("hit", "unsure"));
    slide.querySelectorAll(".prov i").forEach((chip) => chip.classList.remove("on"));
    bot.classList.remove("scan", "shrug", "point");
    look(-10);
    [...route.text].forEach((ch, i) => later(i * 26, () => { text.textContent += ch; }));
    const typed = route.text.length * 26 + 200;

    later(typed, () => { bot.classList.add("scan"); look(-14); });
    later(typed + 900, () => {
      bot.classList.remove("scan");
      level.textContent = route.level;
      conf.textContent = `confidence ${Math.round(route.conf * 100)}%`;
      segments.forEach((s, i) => { if (i < route.level) s.classList.add("on", i >= 7 ? "hot" : i >= 4 ? "warm" : "cool"); });
      task.textContent = route.task;
      task.classList.add("on");
    });
    if (!route.lane) {
      later(typed + 1500, () => { bot.classList.add("shrug"); look(0); });
      later(typed + 3400, one);
      return;
    }
    const bay = slide.querySelector(`.bay[data-lane="${route.lane}"]`);
    const cab = bay.querySelector(".cab");
    later(typed + 1500, () => {
      look(12);
      bot.classList.add("point");
      bay.classList.add("hit");
      bay.querySelector(`.prov .${route.agent}`).classList.add("on");
      // The rider: a spark leaving the message card for the cab's door.
      const [x0, y0] = centerIn(card, root);
      const [x1, y1] = centerIn(cab, root);
      rider.style.transition = "none";
      rider.style.transform = `translate(${x0}px, ${y0}px) scale(1)`;
      rider.style.opacity = "1";
      void rider.offsetWidth;
      rider.style.transition = "transform 0.75s cubic-bezier(0.5, 0, 0.3, 1), opacity 0.2s 0.6s";
      rider.style.transform = `translate(${x1 - 40}px, ${y1}px) scale(0.5)`;
      rider.style.opacity = "0";
      card.classList.add("boarded");
    });
    later(typed + 2300, () => {
      cab.classList.add("go");
      counts[route.lane] += 1;
      bay.querySelector(".count").textContent = counts[route.lane];
      card.classList.add("out");
    });
    // A fresh cab of the same kind glides into the bay.
    later(typed + 3100, () => { cab.classList.remove("go"); cab.classList.add("back"); });
    later(typed + 3150, () => { cab.classList.remove("back"); });
    later(typed + 3700, one);
  };
  one();
}
