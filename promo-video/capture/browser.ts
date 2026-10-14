// Browser side of the capture: a fresh Chrome per run, signed in through the real form with
// the seeded synthetic accounts, pointed only at the loopback promo nodes.
import type { Browser, BrowserContext, CDPSession, Page } from "playwright-core";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchChrome } from "../../test/ui/launch-chrome.js";
import type { PromoEnvironment, PromoNode } from "./env.js";

export async function openBrowser(environment: PromoEnvironment): Promise<Browser> {
  // HOME points into the scratch root, so Chrome never touches a real profile.
  return launchChrome({ headless: true, env: { ...process.env, HOME: environment.nodes[0].home } });
}

export interface Stage { context: BrowserContext; page: Page; node: PromoNode }

// Two things on screen come from the scratch environment and say nothing about the product:
// temp folder paths and the "Unavailable" sync state (no Syncthing runs here). They are
// hidden; nothing else on the page is touched.
// A third: the stand-in agent names a model the price list does not know, so a conversation
// it ran is labelled "API price unavailable" (its tooltip counts 0 priced requests).
const stagingStyle = '.project-card > span, #projectPath, .project-sync-status, .usage-cost[title*=". 0/"] { display: none !important; }';

export async function openStage(browser: Browser, environment: PromoEnvironment, node: PromoNode, viewport: { width: number; height: number }, options: { scale?: number; mobile?: boolean } = {}): Promise<Stage> {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: options.scale ?? 2,
    serviceWorkers: "block",
    colorScheme: "dark",
    locale: "en-US",
    timezoneId: "America/New_York",
    ...(options.mobile ? { isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" } : {}),
  });
  context.setDefaultTimeout(20_000);
  await context.addInitScript(({ css, touch }) => {
    addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = css + `
        #promoPointer { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none; width: 22px; height: 22px; transform: translate(-100px, -100px); filter: drop-shadow(0 2px 3px rgba(0,0,0,.45)); }
        #promoPointer.down { scale: .86; }
        .promoRipple { position: fixed; z-index: 2147483646; pointer-events: none; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%; border: 2px solid rgba(120,220,190,.95); background: rgba(120,220,190,.18); animation: promoRipple .45s ease-out forwards; }
        @keyframes promoRipple { to { width: 58px; height: 58px; margin: -29px 0 0 -29px; opacity: 0; } }`;
      document.head.append(style);
      // Headless frames carry no pointer, so the page draws one that follows the real events.
      const ripple = (x: number, y: number): void => {
        const element = document.createElement("div");
        element.className = "promoRipple";
        element.style.left = `${x}px`;
        element.style.top = `${y}px`;
        document.documentElement.append(element);
        setTimeout(() => element.remove(), 500);
      };
      if (touch) { addEventListener("touchstart", (event) => ripple(event.touches[0].clientX, event.touches[0].clientY), true); return; }
      const pointer = document.createElement("div");
      pointer.id = "promoPointer";
      pointer.innerHTML = '<svg viewBox="0 0 22 22" width="22" height="22"><path d="M3 2l14 7.2-6.2 1.9L8.6 17.5z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
      document.documentElement.append(pointer);
      addEventListener("mousemove", (event) => { pointer.style.transform = `translate(${event.clientX - 3}px, ${event.clientY - 2}px)`; }, true);
      addEventListener("mousedown", (event) => { pointer.classList.add("down"); ripple(event.clientX, event.clientY); }, true);
      addEventListener("mouseup", () => pointer.classList.remove("down"), true);
    });
  }, { css: stagingStyle, touch: Boolean(options.mobile) });
  const page = await context.newPage();
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(node.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => !(document.querySelector("#loginDialog") as HTMLDialogElement | null)?.open);
  return { context, page, node };
}

const pointers = new WeakMap<Page, { x: number; y: number }>();
/** Moves the pointer along an eased path and clicks, the way a hand does. */
export async function glideClick(page: Page, selector: string | { x: number; y: number }, options: { ms?: number; click?: boolean } = {}): Promise<void> {
  let target: { x: number; y: number };
  if (typeof selector === "string") {
    // Lists re-render while they load, and a settings tab can sit below the fold.
    const locator = page.locator(selector).first();
    await locator.waitFor();
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    let box = await locator.boundingBox();
    for (let attempt = 0; !box && attempt < 12; attempt++) { await page.waitForTimeout(120); box = await locator.boundingBox(); }
    if (!box) throw new Error(`Nothing to click at ${selector}`);
    target = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  } else target = selector;
  const from = pointers.get(page) ?? { x: 640, y: 420 };
  const steps = Math.max(8, Math.round((options.ms ?? 420) / 16));
  for (let step = 1; step <= steps; step++) {
    const t = step / steps;
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    await page.mouse.move(from.x + (target.x - from.x) * eased, from.y + (target.y - from.y) * eased);
    await page.waitForTimeout(16);
  }
  pointers.set(page, target);
  if (options.click === false) return;
  await page.mouse.down();
  await page.waitForTimeout(70);
  await page.mouse.up();
}

/** Taps a touch screen at the centre of an element. */
export async function tap(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`Nothing to tap at ${selector}`);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

export interface Recording { stop(): Promise<{ frames: number; seconds: number; file: string; firstFrameAt: number; width: number; height: number }> }

/**
 * Records the page through Chrome's screencast at full device resolution. Every second frame
 * is taken: that is still about thirty a second, at half the load on a machine that is also
 * running three nodes and their agents. Frames arrive only
 * when the picture changes, each with its own time, so the list written here lets ffmpeg
 * rebuild a constant-rate clip with the real timing.
 */
export async function record(page: Page, directory: string, name: string): Promise<Recording> {
  const frameDirectory = path.join(directory, `${name}-frames`);
  await mkdir(frameDirectory, { recursive: true });
  const client: CDPSession = await page.context().newCDPSession(page);
  const frames: Array<{ file: string; time: number }> = [];
  const writes: Array<Promise<void>> = [];
  client.on("Page.screencastFrame", (frame) => {
    const file = path.join(frameDirectory, `${String(frames.length).padStart(5, "0")}.jpg`);
    frames.push({ file, time: frame.metadata.timestamp ?? Date.now() / 1000 });
    writes.push(writeFile(file, Buffer.from(frame.data, "base64")));
    void client.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
  });
  const viewport = page.viewportSize()!;
  const scale = await page.evaluate(() => devicePixelRatio);
  await client.send("Page.startScreencast", { format: "jpeg", quality: 94, maxWidth: Math.round(viewport.width * scale), maxHeight: Math.round(viewport.height * scale), everyNthFrame: 2 });
  const startedAt = Date.now();
  return {
    async stop() {
      // One last repaint so the final state has a frame to hold on.
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await client.send("Page.stopScreencast");
      await Promise.all(writes);
      await client.detach();
      const seconds = (Date.now() - startedAt) / 1000;
      const end = frames[0].time + seconds;
      const list = frames.map((frame, index) => `file '${frame.file}'\nduration ${Math.max(0.001, (frames[index + 1]?.time ?? end) - frame.time).toFixed(4)}`).join("\n");
      const file = path.join(directory, `${name}.txt`);
      await writeFile(file, `ffconcat version 1.0\n${list}\nfile '${frames.at(-1)!.file}'\n`);
      return { frames: frames.length, seconds, file, firstFrameAt: frames[0].time, width: Math.round(viewport.width * scale), height: Math.round(viewport.height * scale) };
    },
  };
}
