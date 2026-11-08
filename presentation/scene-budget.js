// Slide 5 · Budgets, as glass tanks filling with the day's spend: the cluster's month, each team's
// month, each project's day and a few conversations. Checkout fills to its $20 a day: it warns at
// 80%, locks at 100%, and the next turn is refused with the reason and when the period resets.
const money = (value) => `$${value.toLocaleString("en-US", { minimumFractionDigits: value < 100 ? 2 : 0, maximumFractionDigits: value < 100 ? 2 : 0 })}`;
const ease = (t) => 1 - Math.pow(1 - t, 2.2);

export default function budgetScene(slide, { later, loop }) {
  const root = slide.querySelector(".tanks");
  const tubes = [...root.querySelectorAll(".tube, .vial")];
  const spaces = [...root.querySelectorAll(".ws")];
  const cluster = root.querySelector(".cluster-tank .column");
  const clusterValue = root.querySelector(".cluster-tank .tank-value");
  const checkout = root.querySelector("#checkoutTube");
  const refusal = root.querySelector("#refusal");

  const level = (el, share) => { el.querySelector(".liquid").style.height = `${Math.min(100, share * 100)}%`; };
  const run = () => {
    tubes.forEach((tube) => { tube.classList.remove("warning", "full"); level(tube, 0); });
    refusal.classList.remove("on");
    const started = performance.now();
    let done = false;
    loop((now) => {
      if (done) return false;
      const t = Math.min(1, (now - started) / 6500);
      let clusterSpent = Number(cluster.dataset.base);
      for (const space of spaces) {
        let spent = Number(space.dataset.base);
        for (const tube of space.querySelectorAll(".tube, .vial")) {
          const limit = Number(tube.dataset.limit);
          const value = Number(tube.dataset.to) * ease(t);
          level(tube, value / limit);
          const label = tube.querySelector(".tube-value");
          if (label) label.textContent = money(value);
          tube.classList.toggle("warning", value / limit >= 0.8 && value < limit);
          if (!tube.classList.contains("vial")) spent += value;
        }
        space.querySelector(".ws-gauge i").style.width = `${(spent / Number(space.dataset.limit)) * 100}%`;
        space.querySelector(".ws-limit").textContent = `${money(spent)} of ${money(Number(space.dataset.limit))} / month`;
        clusterSpent += spent - Number(space.dataset.base);
      }
      level(cluster.parentElement, clusterSpent / Number(cluster.dataset.limit));
      clusterValue.textContent = money(clusterSpent);
      if (t < 1) return;
      done = true;
      checkout.classList.remove("warning");
      checkout.classList.add("full");
      later(500, () => refusal.classList.add("on"));
      later(9000, run);
    });
  };
  run();
}
