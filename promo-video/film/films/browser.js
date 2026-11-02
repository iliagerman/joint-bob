// Feature: the agent's browser, explained step by step. It opens a staging shop inside the
// conversation, clicks through it like a customer, finds the bug, fixes it and checks again,
// while a person watches the same page live and can take control of it.
import { around, beats, bed, defineFeature, display, events, fit, frameOf, look, say, sfx, spoken } from "../feature.js";

const [open, customer, fix, wheel, tagline] = beats(["browser-01", "browser-02", "browser-03", "browser-04", { name: "browser-05", min: 116 }]);
const end = tagline.from;
const duration = tagline.to;

const desk = display([0, 2.1, 0]);
// Where the live page sits on the recording, in screen fractions.
const page = [0.75, 0.79];

const lines = [
  say(open, "Some bugs only show up in a real browser. In Joint Bob, *the agent gets one,* right inside the conversation."),
  say(customer, "It *clicks through your site the way a customer would.* Here, it adds a mug to the cart, and tries a promo code at checkout."),
  say(fix, "It *sees the error for itself,* reads the code to find the cause, fixes it, and then goes back to check that the order goes through."),
  say(wheel, "You can *watch every step live,* and if you need to, take control of the browser yourself, then hand it back to the agent."),
  { audio: tagline.audio, at: end + 6, until: 0, text: "" },
];

const at = events("browser");
// The request, then the panel opening on the page the agent has just loaded.
// The request being typed, sent, and the panel opening on the page the agent has just loaded.
const a = fit("browser", open.from, open.to, 0.4, at.live + 1.8);
// Into the cart, to checkout, the promo code.
const b = fit("browser", customer.from, customer.to, at.adding + 0.2, at.applying + 2.2);
// The error, the fix, the same steps again, and a test order.
const c = fit("browser", fix.from, fix.to, at.applying + 2.2, at.done + 1.2);
// A person takes control, and hands it back.
const d = fit("browser", wheel.from, end, at.control - 1.2, at.resumed + 2.0);
const reproduced = frameOf(c, at.reproduced - 0.6);
const confirmed = frameOf(c, at.done - 1.4);
const control = frameOf(d, at.control + 0.2);
const resumed = frameOf(d, at.resumed);

export default defineFeature({
  id: "browser",
  kicker: "Agent browser",
  duration,
  end,
  tagline: ["Give your agent", "a real browser."],
  devices: { desk },
  screens: () => ({ desk: [a, b, c, d] }),
  shots: [
    { from: open.from, to: open.at + 60, start: look(desk, 0.3, 0.8, 4.8, 0.2), end: look(desk, 0.32, 0.8, 4.2, 0.1) },
    { from: open.at + 60, to: open.to, start: look(desk, 0.55, 0.52, 6.4, 0.2), end: look(desk, 0.6, 0.56, 5.4, 0.1) },
    { from: customer.from, to: customer.to, start: look(desk, ...page, 3.6, -0.1), end: look(desk, ...page, 3.0, -0.03) },
    { from: fix.from, to: reproduced + 40, start: look(desk, 0.62, 0.72, 4.6, 0.1), end: look(desk, 0.64, 0.74, 4.0, 0.05) },
    { from: reproduced + 40, to: confirmed - 10, start: look(desk, 0.3, 0.6, 4.6, -0.1), end: look(desk, 0.28, 0.6, 4.2, -0.04) },
    { from: confirmed - 10, to: fix.to, start: look(desk, ...page, 3.5, 0.1), end: look(desk, ...page, 3.0, 0.03) },
    { from: wheel.from, to: end, start: look(desk, 0.7, 0.5, 4.8, -0.1), end: look(desk, 0.72, 0.5, 4.0, -0.03) },
    { from: end, to: duration, start: look(desk, 0.5, 0.45, 7.5, 0.6), end: look(desk, 0.5, 0.45, 9.5, 0.2) },
  ],
  rings: [
    { from: reproduced, to: reproduced + 40, ...around(desk, 0.555, 0.815, 0.825, 0.875), sun: true },
    { from: control, to: end - 4, ...around(desk, 0.522, 0.365, 0.75, 0.45) },
  ],
  stickers: [
    { text: "Inside the conversation 🌐", paint: "mint", from: open.at + 70, to: open.to - 4, at: { x: 1380, y: 250 }, tilt: 3, size: 42 },
    { text: "Real clicks, real page 👆", paint: "ink", from: customer.at + 20, to: customer.to - 4, at: { x: 1500, y: 200 }, tilt: -3, size: 42 },
    { text: "Reproduced 🐛", paint: "danger", from: reproduced, to: reproduced + 40, at: { x: 420, y: 320 }, tilt: -4, size: 48 },
    { text: "Fixed 🔧", paint: "mint", from: reproduced + 46, to: confirmed - 12, at: { x: 1560, y: 220 }, tilt: 4, size: 48 },
    { text: "Order went through ✅", paint: "mint", from: confirmed, to: fix.to - 4, at: { x: 1480, y: 220 }, tilt: -3, size: 46 },
    { text: "You have control ✋", paint: "sun", from: control, to: resumed - 2, at: { x: 560, y: 300 }, tilt: -3, size: 44 },
    { text: "Back to the agent ▶️", paint: "mint", from: resumed, to: end - 4, at: { x: 560, y: 300 }, tilt: 3, size: 44 },
  ],
  confetti: [{ at: confirmed, origin: { x: 1100, y: 520 }, until: fix.to }],
  lines,
  sounds: [bed(duration, 25), ...spoken(lines), sfx("pop", open.at + 70), sfx("pop", customer.at + 20), sfx("pop", reproduced), sfx("party", confirmed), sfx("pop", control), sfx("chime", resumed)],
});
