// Regenerates the four logo options and the comparison page. Run: node tools/build.mjs
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { optionA, optionB, optionC, optionD } from "./snufkin.mjs";

const out = fileURLToPath(new URL("..", import.meta.url));
const options = [
  { file: "option-a-portrait.svg", svg: optionA(), title: "A. Portrait", note: "Full pen-and-ink portrait: curled hat, pipe and smoke, harmonica in the pocket." },
  { file: "option-b-badge.svg", svg: optionB(), title: "B. Badge", note: "Portrait in a ring; the hat tip and smoke break out of the frame." },
  { file: "option-c-hat-smoke.svg", svg: optionC(), title: "C. Hat and smoke", note: "Just the hat, with smoke curling from its tip. Works as a compact mark." },
  { file: "option-d-bold.svg", svg: optionD(), title: "D. Bold", note: "Heavier lines, no hatching. Built to stay readable at favicon sizes." },
];
for (const o of options) fs.writeFileSync(`${out}/${o.file}`, o.svg);

// Each logo is defined once as a symbol, then reused at every size.
const inner = (svg, i) => svg.replace(/^<svg[^>]*>\n/, "").replace(/<\/svg>\s*$/, "").replace(/\b(tile|badge)\b/g, `$1-${i}`);
const symbols = options.map((o, i) => `<symbol id="opt${i}" viewBox="0 0 512 512">${inner(o.svg, i)}</symbol>`).join("\n");
const use = (i, cls) => `<svg class="${cls}" viewBox="0 0 512 512" role="img" aria-label="${options[i].title}"><use href="#opt${i}"/></svg>`;
const cards = options.map((o, i) => `    <figure>
      ${use(i, "logo")}
      <figcaption><strong>${o.title}</strong><br>${o.note}</figcaption>
      <div class="sizes">${use(i, "s64")}${use(i, "s32")}${use(i, "s16")}</div>
    </figure>`).join("\n");

fs.writeFileSync(`${out}/index.html`, `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Joint Bob logo options: Snufkin</title>
  <style>
    body { margin: 0; padding: 32px; background: #0d0f10; color: #f7f3e8; font-family: system-ui, sans-serif; }
    h1 { margin: 0 0 24px; font-size: 22px; font-weight: 600; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 24px; }
    figure { margin: 0; padding: 24px; border-radius: 16px; background: #1b1e20; text-align: center; }
    .logo { display: block; width: min(100%, 360px); height: auto; margin: 0 auto; }
    figcaption { margin-top: 14px; font-size: 15px; line-height: 1.4; }
    .sizes { display: flex; gap: 16px; justify-content: center; align-items: flex-end; margin-top: 16px; }
    .s64 { width: 64px; height: 64px; } .s32 { width: 32px; height: 32px; } .s16 { width: 16px; height: 16px; }
  </style>
</head>
<body>
  <svg width="0" height="0" style="position:absolute" aria-hidden="true">
${symbols}
  </svg>
  <h1>Joint Bob logo options: Snufkin</h1>
  <div class="grid">
${cards}
  </div>
</body>
</html>
`);
console.log("built", options.map((o) => o.file).join(", "));
