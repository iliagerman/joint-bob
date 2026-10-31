// Snufkin drawn in pen and ink. Each part draws into a Drawing; options combine them.
import { Drawing } from "./ink.mjs";

export const CREAM = "#f7f3e8", TEAL = "#37cfab", BG = "#141618";
const disc = (cx, cy, r, n = 8) => Array.from({ length: n }, (_, i) => [cx + r * Math.cos((i * 2 * Math.PI) / n), cy + r * Math.sin((i * 2 * Math.PI) / n)]);

export function drawCoat(d, { detail = true } = {}) {
  d.fill([[70,520],[92,452],[132,408],[196,384],[238,374],[268,392],[318,384],[372,402],[414,440],[442,520]], BG);
  d.hatch([[70,520],[92,452],[132,408],[196,384],[214,420],[196,470],[170,520]], { angle: 52, gap: 8, w: 1.7, opacity: 0.8 });
  d.ink([[70,520],[92,452],[132,408],[196,384],[238,374]], { w: 5.5, taper: [0.05, 0.3] });
  d.ink([[268,392],[318,384],[372,402],[414,440],[442,520]], { w: 5.5, taper: [0.25, 0.05] });
  d.fill([[232,370],[218,396],[258,404],[266,376]], BG);
  d.ink([[232,370],[218,396],[258,404],[266,376]], { w: 4.5, closed: true });
  d.fill([[270,384],[268,414],[316,404],[312,378]], BG);
  d.ink([[270,384],[268,414],[316,404],[312,378]], { w: 4.5, closed: true });
  d.ink([[272,414],[282,452],[286,520]], { w: 4.2, taper: [0.05, 0.2] });
  if (!detail) return;
  for (const y of [452, 488]) d.fill(disc(290, y, 4.2), CREAM);
  // harmonica sticking out of the breast pocket
  d.fill([[332,414],[376,408],[379,430],[335,436]], BG);
  d.ink([[332,414],[376,408],[379,430],[335,436]], { w: 3.6, closed: true, color: TEAL });
  for (let i = 0; i < 6; i++) { const x = 340 + i * 6.6; d.fill(disc(x, 424 - (x - 340) * 0.17, 1.7, 6), TEAL); }
  d.fill([[326,430],[380,424],[384,474],[330,480]], BG);
  d.ink([[326,430],[380,424],[384,474],[330,480]], { w: 3.8, closed: true });
  d.ink([[330,442],[382,436]], { w: 2.4, opacity: 0.7 });
  d.ink([[150,440],[140,470],[128,500]], { w: 3, opacity: 0.8 });
  d.ink([[380,448],[392,478],[398,508]], { w: 3, opacity: 0.8 });
}

export function drawNeck(d) {
  d.fill([[246,336],[238,376],[300,386],[298,350]], BG);
  d.ink([[246,338],[240,372]], { w: 4.5, taper: [0.1, 0.4] });
  d.ink([[298,352],[300,384]], { w: 4.5, taper: [0.1, 0.4] });
}

export function drawHead(d, { detail = true } = {}) {
  d.fill([[198,250],[308,250],[316,266],[332,284],[351,303],[323,310],[324,317],[316,324],[321,333],[310,350],[284,356],[262,350],[236,338],[208,318],[190,284]], BG);
  d.ink([[306,250],[316,266],[332,284],[351,303],[323,310],[324,317],[316,324],[321,333],[310,350],[286,357]], { w: 5.2, taper: [0.04, 0.2] });
  d.ink([[286,357],[264,352],[240,340]], { w: 3.6, taper: [0.1, 0.5], opacity: 0.9 });
  d.ink([[287,262],[298,257],[311,259]], { w: 3.6, taper: [0.2, 0.3] });
  d.ink([[289,273],[298,269],[306,272],[298,276]], { w: 2.6, closed: true });
  d.fill(disc(298, 273, 3), CREAM);
  if (detail) d.ink([[337,300],[330,304],[326,300]], { w: 2.4, taper: [0.3, 0.3] });
  d.ink([[316,326],[304,329],[296,326]], { w: 2.8, taper: [0.1, 0.5] });
  if (detail) {
    d.ink([[250,290],[258,294],[258,308],[250,312],[244,302]], { w: 3.4, closed: true });
    d.ink([[250,298],[253,302],[250,306]], { w: 2, taper: [0.2, 0.2] });
  }
  d.hatch([[190,284],[222,262],[240,300],[234,336],[208,318]], { angle: 80, gap: 5, w: 1.8, opacity: 0.95 });
  d.ink([[198,254],[190,284],[208,318],[236,336]], { w: 4.6, taper: [0.05, 0.3] });
  d.hatch([[206,250],[304,250],[296,270],[210,282]], { angle: 62, gap: 5, w: 1.5, opacity: 0.8, inset: 1.5 });
}

export function drawPipe(d) {
  d.ink([[317,331],[336,338],[356,346]], { w: 5.5, taper: [0.1, 0.1] });
  d.fill([[350,350],[348,326],[372,322],[376,348],[362,358]], BG);
  d.ink([[350,350],[348,326],[372,322],[376,348],[362,358]], { w: 4.6, closed: true });
  d.ink([[352,334],[372,330]], { w: 2.4, opacity: 0.8 });
  d.fill(disc(361, 323, 4), TEAL);
}

export function drawSmoke(d) {
  d.ink([[364,316],[388,298],[392,276],[412,256],[404,232],[426,212],[418,188],[438,166]], { w: 6.5, color: TEAL, taper: [0.08, 0.6], wob: 1.4 });
  d.ink([[374,314],[398,300],[404,284]], { w: 3.6, color: TEAL, opacity: 0.65, taper: [0.1, 0.6] });
}

const H = (pts) => pts.map(([x, y]) => [250 + (x - 250) * 0.92 - 4, 252 + (y - 252) * 0.92 - 4]);
export const HAT_TIP = H([[298, 42]])[0];

export function drawHat(d) {
  const crown = H([[118,250],[148,198],[176,140],[214,90],[250,52],[274,36],[298,42],[306,60],[296,78],[298,112],[318,162],[352,210],[374,252]]);
  const crownFill = crown.map((p, i) => (i === 0 ? [p[0] + 26, p[1]] : i === crown.length - 1 ? [p[0] - 24, p[1]] : p));
  d.fill(crownFill, BG);
  d.fill(crownFill, TEAL, 0.1);
  d.hatch(H([[262,70],[296,78],[298,112],[318,162],[352,210],[374,252],[322,246],[286,206],[262,150]]), { color: TEAL, angle: 58, gap: 6, w: 1.9, opacity: 0.85 });
  d.hatch(H([[148,198],[176,140],[214,90],[232,104],[214,152],[196,206],[150,246]]), { color: TEAL, angle: 62, gap: 8, w: 1.6, opacity: 0.55 });
  d.ink(H([[118,250],[148,198],[176,140],[214,90],[250,52],[274,36],[298,42],[306,60],[296,78]]), { w: 6.5, color: TEAL, taper: [0.03, 0.25] });
  d.ink(H([[296,78],[298,112],[318,162],[352,210],[374,252]]), { w: 6.5, color: TEAL, taper: [0.2, 0.04] });
  d.ink(H([[212,160],[228,118],[252,84],[272,66]]), { w: 3.2, color: TEAL, taper: [0.1, 0.5] });
  d.ink(H([[283,52],[287,66],[281,76]]), { w: 3, color: TEAL, taper: [0.2, 0.3] });
  const band = H([[126,236],[250,214],[356,234],[362,250],[250,236],[122,254]]);
  d.fill(band, BG);
  d.fill(band, TEAL, 0.32);
  d.ink(H([[126,236],[250,214],[356,234]]), { w: 4, color: TEAL, taper: [0.05, 0.05] });
  d.ink(H([[122,254],[250,236],[362,250]]), { w: 4, color: TEAL, taper: [0.05, 0.05] });
  const brim = H([[80,262],[128,238],[200,230],[262,229],[324,234],[362,250],[380,270],[352,268],[300,256],[250,254],[190,258],[128,272]]);
  d.fill(brim, BG);
  d.fill(brim, TEAL, 0.14);
  d.hatch(H([[80,262],[128,272],[190,258],[250,254],[250,244],[190,246],[128,252]]), { color: TEAL, angle: 70, gap: 6, w: 1.6, opacity: 0.7, inset: 1.5 });
  d.ink(brim, { w: 6.2, color: TEAL, closed: true, pressure: 0.4 });
}

const wrapSvg = (label, body, radius = 112) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="${label}">
  <defs><clipPath id="tile"><rect width="512" height="512" rx="${radius}"/></clipPath></defs>
  <rect width="512" height="512" rx="${radius}" fill="${BG}"/>
  <g clip-path="url(#tile)">
${body}
  </g>
</svg>
`;

// A: detailed portrait
export function optionA() {
  const d = new Drawing(11);
  drawCoat(d); drawNeck(d); drawHead(d); drawPipe(d); drawSmoke(d); drawHat(d);
  return d.svg({ label: "Joint Bob logo, option A: Snufkin portrait" });
}

// B: round badge, hat tip and smoke break out of the ring
export function optionB() {
  const s = 0.78, cx = 256, cy = 298, r = 180;
  const place = (d) => { d.s = s; d.tx = 256 - 250 * s; d.ty = 300 - 300 * s; };
  const inner = new Drawing(21); place(inner);
  drawCoat(inner); drawNeck(inner); drawHead(inner); drawPipe(inner);
  const ring = new Drawing(31);
  ring.fill(disc(cx, cy, r, 28), "#1b1e20");
  const outer = new Drawing(41); place(outer);
  drawSmoke(outer); drawHat(outer);
  const rg = new Drawing(51);
  rg.ink(disc(cx, cy, r, 28), { w: 6, closed: true, pressure: 0.35 });
  rg.ink(disc(cx, cy, r - 13, 28), { w: 2.4, closed: true, color: TEAL, opacity: 0.7, wob: 1.2 });
  const body = `  ${ring.paths()}\n  <clipPath id="badge"><circle cx="${cx}" cy="${cy}" r="${r - 3}"/></clipPath>\n  <g clip-path="url(#badge)">\n  ${inner.paths()}\n  </g>\n  ${rg.paths()}\n  ${outer.paths()}`;
  return wrapSvg("Joint Bob logo, option B: Snufkin badge", body);
}

// C: the hat on its own with smoke rising from the curled tip
export function optionC() {
  const d = new Drawing(61);
  d.s = 1.16; d.tx = -8; d.ty = 112;
  drawHat(d);
  const e = new Drawing(71);
  e.hatch([[136,438],[256,430],[376,438],[256,452]], { angle: 8, gap: 4.5, w: 1.5, opacity: 0.5, inset: 2 });
  e.ink([[150,442],[256,452],[364,442]], { w: 4, opacity: 0.8, taper: [0.2, 0.2] });
  e.ink([[304,166],[326,142],[306,120],[334,96],[320,72],[348,50]], { w: 7, color: TEAL, taper: [0.08, 0.6], wob: 1.4 });
  e.ink([[316,160],[340,146],[338,126]], { w: 4, color: TEAL, opacity: 0.6, taper: [0.1, 0.6] });
  return wrapSvg("Joint Bob logo, option C: Snufkin hat and smoke", `  ${e.paths()}\n  ${d.paths()}`);
}

// D: bold version for small sizes, no hatching
export function optionD() {
  const d = new Drawing(81);
  d.hatching = false; d.ws = 1.45;
  drawCoat(d, { detail: false }); drawNeck(d); drawHead(d, { detail: false }); drawPipe(d); drawSmoke(d); drawHat(d);
  return d.svg({ label: "Joint Bob logo, option D: Snufkin bold" });
}

// ---------- app icon, favicon and boot splash ----------
// Solid-colour Snufkin (hat, face, pipe, shoulders) so the mark still reads as a person at 16-32px,
// where thin outlines collapse into a bare triangle. `lite` trims path detail for the inline splash.
const MARK = { teal: TEAL, tealShade: "#23a086", tealDeep: "#0f6b58", skin: "#f7f3e8", skinShade: "#d8d2c4", hair: "#8d8878", coat: "#2b3236" };

export function markParts({ lite = false } = {}) {
  const view = (d) => { Object.assign(d, { s: 1.05, tx: 11.5, ty: -15.5, lite }); return d; };
  const body = view(new Drawing(101));
  const hat = view(new Drawing(102));
  const smoke = view(new Drawing(103));
  const wisp = view(new Drawing(104));
  const c = MARK;

  // coat and shoulders, bleeding off the bottom of the tile
  body.fill([[60,540],[86,452],[132,408],[196,384],[238,374],[268,392],[318,384],[372,402],[420,440],[452,540]], c.coat);
  body.hatch([[60,540],[86,452],[132,408],[196,384],[214,420],[196,470],[170,540]], { angle: 52, gap: 9, w: 2.2, opacity: 0.45 });
  body.ink([[60,540],[86,452],[132,408],[196,384],[238,374]], { w: 12, taper: [0.05, 0.3] });
  body.ink([[268,392],[318,384],[372,402],[420,440],[452,540]], { w: 12, taper: [0.25, 0.05] });
  body.fill([[232,370],[218,396],[258,404],[266,376]], c.skinShade);
  body.fill([[270,384],[268,414],[316,404],[312,378]], c.skinShade);
  body.ink([[272,414],[282,452],[286,540]], { w: 8, taper: [0.05, 0.2], color: c.skinShade });
  // neck and head
  body.fill([[246,336],[238,376],[300,386],[298,350]], c.skinShade);
  const head = [[198,250],[308,250],[316,266],[332,284],[351,303],[323,310],[324,317],[316,324],[321,333],[310,350],[284,356],[262,350],[236,338],[208,318],[190,284]];
  body.fill(head, c.skin);
  body.ink([[306,250],[316,266],[332,284],[351,303],[323,310],[324,317],[316,324],[321,333],[310,350],[286,357]], { w: 10, color: c.skin, taper: [0.04, 0.2] });
  body.fill([[190,284],[222,262],[240,300],[234,336],[208,318]], c.hair);
  body.ink([[198,254],[190,284],[208,318],[236,336]], { w: 8, color: c.hair, taper: [0.05, 0.3] });
  body.fill(disc(298, 273, 5.5), BG);
  body.ink([[286,261],[298,255],[312,258]], { w: 6.5, color: BG, taper: [0.2, 0.3] });
  body.ink([[316,326],[304,329],[296,326]], { w: 5, color: BG, taper: [0.1, 0.5] });
  // pipe
  body.ink([[317,331],[336,338],[356,346]], { w: 10, color: c.skin, taper: [0.1, 0.1] });
  body.fill([[350,350],[348,326],[372,322],[376,348],[362,358]], c.skin);
  body.fill(disc(361, 326, 5.5), c.teal);

  smoke.ink([[364,316],[388,298],[392,276],[412,256],[404,232],[426,212],[418,188],[438,166]], { w: 14, color: c.teal, taper: [0.08, 0.6], wob: 1.4 });
  wisp.ink([[374,314],[398,300],[404,284]], { w: 8, color: c.teal, opacity: 0.65, taper: [0.1, 0.6] });

  // hat: solid crown with a shaded side, dark band and a fold, wide brim
  const crown = H([[118,250],[148,198],[176,140],[214,90],[250,52],[274,36],[298,42],[306,60],[296,78],[298,112],[318,162],[352,210],[374,252]]);
  hat.fill(crown.map((p, i) => (i === 0 ? [p[0] + 26, p[1]] : i === crown.length - 1 ? [p[0] - 24, p[1]] : p)), c.teal);
  hat.fill(H([[262,70],[296,78],[298,112],[318,162],[352,210],[374,252],[322,246],[286,206],[262,150]]), c.tealShade);
  hat.ink(crown, { w: 11, color: c.teal, taper: [0.03, 0.04] });
  hat.ink(H([[212,160],[228,118],[252,84],[272,66]]), { w: 6, color: c.tealDeep, taper: [0.1, 0.5] });
  hat.fill(H([[126,236],[250,214],[356,234],[362,250],[250,236],[122,254]]), c.tealDeep);
  const brim = H([[80,262],[128,238],[200,230],[262,229],[324,234],[362,250],[380,270],[352,268],[300,256],[250,254],[190,258],[128,272]]);
  hat.fill(brim, c.teal);
  hat.hatch(H([[80,262],[128,272],[190,258],[250,254],[250,244],[190,246],[128,252]]), { color: c.tealDeep, angle: 70, gap: 7, w: 2.4, opacity: 0.8, inset: 1.5 });
  hat.ink(brim, { w: 11, color: c.teal, closed: true, pressure: 0.3 });
  return { body: body.paths(), smoke: smoke.paths(), wisp: wisp.paths(), hat: hat.paths() };
}

export function iconSvg() {
  const { body, smoke, wisp, hat } = markParts();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Joint Bob icon">
  <defs><clipPath id="tile"><rect width="512" height="512" rx="112"/></clipPath></defs>
  <rect width="512" height="512" rx="112" fill="${BG}"/>
  <g clip-path="url(#tile)">
  <g id="figure">
  ${body}
  </g>
  <g id="smoke">
  ${smoke}
  ${wisp}
  </g>
  <g id="hat">
  ${hat}
  </g>
  </g>
</svg>
`;
}

// Inline splash mark: same drawing, with classes the boot CSS animates.
export function bootSvg() {
  const { body, smoke, wisp, hat } = markParts({ lite: true });
  const asClass = (paths, cls) => paths.replace("<path ", `<path class="${cls}" `);
  return `<svg class="app-boot-mark" viewBox="0 0 512 512" aria-hidden="true">
          <defs><clipPath id="boot-clip"><rect width="512" height="512" rx="112"/></clipPath></defs>
          <rect class="boot-tile" width="512" height="512" rx="112"/>
          <g clip-path="url(#boot-clip)">
          ${body}
          ${asClass(smoke, "boot-smoke boot-smoke-main")}
          ${asClass(wisp, "boot-smoke boot-smoke-wisp")}
          <g class="boot-hat">
          ${hat}
          </g>
          </g>
        </svg>`;
}
