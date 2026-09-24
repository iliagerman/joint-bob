import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { type Browser, type Page } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "../dev-nodes.js";

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let server: ChildProcess;
let syncthing: Server;
let browser: Browser;
let page: Page;
const consoleErrors: string[] = [];

async function startFakeSyncthing(): Promise<string> {
  syncthing = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/rest/config/folders") { response.end("[]"); return; }
    if (request.method === "POST" && request.url === "/rest/config/folders") { response.end("{}"); return; }
    if (request.method === "GET" && request.url === "/rest/system/status") { response.end('{"myID":"LOCAL"}'); return; }
    if (request.method === "GET" && request.url?.startsWith("/rest/db/ignores")) { response.end('{"ignore":[]}'); return; }
    if (request.method === "POST" && request.url?.startsWith("/rest/db/ignores")) { response.end("{}"); return; }
    response.statusCode = 404;
    response.end();
  });
  const port = await new Promise<number>((resolve) => syncthing.listen(0, "127.0.0.1", () => resolve((syncthing.address() as { port: number }).port)));
  return `http://127.0.0.1:${port}`;
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-shortcut-hints-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  const syncthingUrl = await startFakeSyncthing();
  server = await startDevNode(environment, node, { PI_MOBILE_WEB_SYNCTHING_URL: syncthingUrl, PI_MOBILE_WEB_SYNCTHING_API_KEY: "test-key" });
  browser = await launchChrome({ headless: process.env.HEADED !== "1" });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
}, { timeout: 120_000 });

after(async () => {
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (syncthing) await new Promise<void>((resolve, reject) => syncthing.close((error) => error ? reject(error) : resolve()));
  if (root) await rm(root, { recursive: true, force: true });
});

async function signIn(): Promise<void> {
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 20_000 });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card").first().waitFor({ timeout: 20_000 });
}

const hint = (testid: string) => page.locator(`[data-testid="${testid}"] .shortcut-hint`);

// The badges only exist on screen while the command modifiers are held, so every
// assertion about them holds Control+Option first and lets go afterwards.
async function holdingModifiers<T>(read: () => Promise<T>): Promise<T> {
  await page.keyboard.down("Control");
  await page.keyboard.down("Alt");
  await page.locator("body.shortcuts-revealed").waitFor({ timeout: 2000 });
  try { return await read(); } finally {
    await page.keyboard.up("Alt");
    await page.keyboard.up("Control");
  }
}

test("header icons reveal the shortcut that opens them while the modifiers are held", async () => {
  await signIn();
  assert.equal(await hint("recent-sessions-open-button").isVisible(), false, "a resting button shows no badge");
  // Every command rides Control+Option, so the badge carries the key alone and the
  // whole chord stays in the badge's tooltip.
  await holdingModifiers(async () => {
    assert.equal(await hint("recent-sessions-open-button").innerText(), "K", "recents shows its key");
    assert.equal(await hint("pending-reviews-open-button").innerText(), "R", "reviews shows its key");
    assert.equal(await hint("running-conversations-open-button").innerText(), "O", "running shows its key");
    assert.equal(await hint("settings-open-button").innerText(), ",", "settings shows its key");
    assert.equal(await hint("projects-open-canvas-button").innerText(), "V", "the canvas launch shows its key");
  });
  assert.equal(await hint("recent-sessions-open-button").isVisible(), false, "letting go hides the badges again");
  assert.equal(await hint("recent-sessions-open-button").getAttribute("title"), process.platform === "darwin" ? "\u2303\u2325K" : "Ctrl+Alt+K", "the badge spells the whole chord on hover");
});

test("canvas shares the top toolbar with larger icons and readable shortcut badges", async () => {
  const tools = page.locator("#projectsPanel .project-actions");
  assert.equal(await tools.locator("#openCanvasButton").count(), 1, "Canvas belongs beside Settings");
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  for (const button of await tools.locator("button:visible").all()) {
    const icon = await button.locator("svg").boundingBox();
    assert.ok(icon && icon.width >= 20, `toolbar icon must be at least 20px, got ${icon?.width}`);
    const font = await button.locator(".shortcut-hint").evaluate((badge) => parseFloat(getComputedStyle(badge).fontSize));
    assert.ok(font >= 13, `shortcut needs at least 13px, got ${font}`);
    // The badge hangs under the button, so carrying one costs the button no height.
    const box = await button.boundingBox();
    assert.ok(box && box.height <= 36, `a toolbar button stays icon-sized, got ${box?.height}px tall`);
  }
  const rows = await tools.locator("button:visible").evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().top));
  assert.ok(rows.every((top) => top === rows[0]), "all visible toolbar buttons fit on one row");
});

test("chat controls advertise shortcuts", async () => {
  for (const id of ["chat-node-select", "chat-harness-select", "chat-model-button", "chat-reasoning-select", "chat-open-terminal-button", "chat-open-browser-button", "chat-notify-button", "chat-add-to-canvas-button", "chat-rename-button", "chat-cron-button", "background-tasks-open", "chat-files-button"]) {
    const control = page.getByTestId(id);
    const host = await control.evaluate((element) => element.closest("[data-shortcut-hint]")?.getAttribute("data-shortcut-hint"));
    assert.ok(host, `${id} needs a shortcut hint`);
  }
  assert.equal(await page.getByTestId("chat-safeguards-button").count(), 0);
});

test("Escape closes recent conversations even with a search query", async () => {
  for (const query of ["", "Thread"]) {
    await page.getByTestId("recent-sessions-open-button").click();
    const dialog = page.getByTestId("recent-sessions-dialog");
    await dialog.waitFor({ state: "visible" });
    await page.getByTestId("recent-sessions-search-input").fill(query);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 2000 });
    assert.equal(await page.getByTestId("recent-sessions-open-button").evaluate((button) => button === document.activeElement), true);
  }
});

test("the running and settings shortcuts open their dialogs", async () => {
  await page.keyboard.press("Control+Alt+KeyO");
  await page.getByTestId("running-conversations-dialog").waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await page.getByTestId("running-conversations-dialog").waitFor({ state: "hidden" });
  await page.keyboard.press("Control+Alt+Comma");
  await page.getByTestId("settings-dialog").waitFor({ state: "visible" });
  await page.getByTestId("settings-cancel-button").click();
  await page.getByTestId("settings-dialog").waitFor({ state: "hidden" });
});

test("a saved chord retitles the badges without a reload", async () => {
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-dialog").waitFor({ state: "visible" });
  await page.getByTestId("settings-tab-shortcuts").click();
  const recents = page.getByTestId("canvas-keymap-recents-input");
  await recents.click();
  await page.keyboard.press("Control+KeyJ");
  await page.getByTestId("canvas-keymap-save-button").click();
  await page.getByTestId("canvas-keymap-status").filter({ hasText: "Saved." }).waitFor();
  await page.getByTestId("settings-cancel-button").click();
  await page.getByTestId("settings-dialog").waitFor({ state: "hidden" });
  assert.equal(await hint("recent-sessions-open-button").textContent(), "J", "the badge follows the saved chord");

  // Put the defaults back so the other tests keep seeing them.
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-dialog").waitFor({ state: "visible" });
  await page.getByTestId("settings-tab-shortcuts").click();
  await page.getByTestId("canvas-keymap-reset-button").click();
  await page.getByTestId("canvas-keymap-save-button").click();
  await page.getByTestId("canvas-keymap-status").filter({ hasText: "Saved." }).waitFor();
  await page.getByTestId("settings-cancel-button").click();
  await page.getByTestId("settings-dialog").waitFor({ state: "hidden" });
  assert.equal(await hint("recent-sessions-open-button").textContent(), "K");
});

test("the board stays hidden from navigation and keyboard shortcuts", async () => {
  assert.equal(await page.getByTestId("projects-open-board-button").isVisible(), false, "desktop navigation hides the board");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.getByTestId("nav-chats-button").isVisible(), true, "mobile navigation is visible for the check");
  assert.equal(await page.getByTestId("nav-board-button").isVisible(), false, "mobile navigation hides the board");
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-dialog").waitFor({ state: "visible" });
  await page.getByTestId("settings-tab-shortcuts").click();
  assert.equal(await page.getByTestId("canvas-keymap-board-input").count(), 0, "shortcut settings omit the board");
  await page.getByTestId("settings-cancel-button").click();

  await page.keyboard.press("Control+Alt+KeyD");
  assert.equal(await page.locator("body").evaluate((body) => body.classList.contains("view-board")), false, "the old board chord does nothing");
});

test("the project title keeps collapse while its action row sits above search", async () => {
  const header = await page.locator("#projectsPanel .panel-bar").boundingBox();
  const actions = await page.locator("#projectsPanel .project-actions").boundingBox();
  const search = await page.locator("#projectsPanel .project-search-row").boundingBox();
  assert.ok(header && actions && search, "the project panel rows rendered");
  assert.equal(await page.locator("#projectsPanel .panel-bar > #collapseProjectsButton").count(), 1, "collapse stays in the title row");
  assert.equal(await page.locator("#projectsPanel > .project-actions").count(), 1, "other actions leave the title row");
  assert.ok(actions!.y >= header!.y + header!.height - 1, `actions row (y=${actions!.y}) starts below the title row (ends ${header!.y + header!.height})`);
  assert.ok(actions!.y + actions!.height <= search!.y, `actions row ends above search (${actions!.y + actions!.height}px vs ${search!.y}px)`);

  // Neither the name nor the subtitle may be truncated now that the buttons moved away.
  const cut = await page.locator("#projectsPanel .brand-copy")
    .evaluate((node) => [...node.children].some((child) => child.scrollWidth > child.clientWidth + 1));
  assert.equal(cut, false, "the app name and subtitle fit their row");
});

test("the chat toolbar splits its controls across two rows and hangs the badges below them", async () => {
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card", { hasText: "Thread-Based Agent Builder" }).click();
  await page.locator("#modelButton:enabled").waitFor();
  // Wide enough that neither row re-wraps, so the two-row split is unambiguous.
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

  const resting = await page.evaluate(() => {
    const bar = document.querySelector("#chatToolbar")!;
    return {
      badges: [...bar.querySelectorAll(".shortcut-hint")].filter((badge) => badge.getBoundingClientRect().height > 0).length,
      controls: ["#chatNodeSelect", "#chatHarnessSelect", "#modelButton", "#reasoningLevelSelect"]
        .map((selector) => bar.querySelector(selector)!.getBoundingClientRect())
        .map((box) => Math.round((box.top + box.bottom) / 2 * 10) / 10),
      actions: ["#openTerminalButton", "#openBrowserButton", "#notifyButton", "#addToCanvasButton", "#renameSessionButton", "#chatCronButton"]
        .map((selector) => [...bar.querySelector(selector)!.childNodes]
          .find((child) => child.nodeType === Node.TEXT_NODE && child.textContent!.trim()))
        .map((text) => {
          if (!text) return null;
          const range = document.createRange();
          range.selectNode(text);
          const box = range.getBoundingClientRect();
          return Math.round((box.top + box.bottom) / 2 * 10) / 10;
        }),
      // The trailing actions must stay inside the toolbar box instead of riding off the panel edge.
      fits: (() => {
        const barBox = bar.getBoundingClientRect();
        const visible = [...bar.querySelectorAll("button")].filter((button) => button.getBoundingClientRect().height > 0);
        const last = visible[visible.length - 1].getBoundingClientRect();
        return last.right <= barBox.right + 0.5;
      })(),
    };
  });

  // Every badge hangs under the control it belongs to: clear of the label, still
  // centred on it, and out of the layout so it neither adds a line nor moves one.
  const overlays = await holdingModifiers(() => page.evaluate(() => {
    const bar = document.querySelector("#chatToolbar")!;
    return [...bar.querySelectorAll(".shortcut-hint")].map((badge) => {
      const host = badge.parentElement!.getBoundingClientRect();
      const box = badge.getBoundingClientRect();
      return {
        below: box.top >= host.bottom - 1 && box.top - host.bottom <= 8,
        centred: Math.abs((box.left + box.right) / 2 - (host.left + host.right) / 2) <= 1,
        height: box.height,
      };
    });
  }));

  await page.setViewportSize({ width: 1440, height: 900 });

  assert.equal(resting.badges, 0, "a resting toolbar shows no badges at all");
  assert.ok(overlays.length >= 7, `every toolbar control carries a badge, saw ${overlays.length}`);
  assert.ok(overlays.every((badge) => badge.below && badge.centred), `each badge sits under its own control, got ${JSON.stringify(overlays)}`);
  assert.equal(resting.fits, true, "the trailing actions stay inside the toolbar");
  // The desktop toolbar reads as two rows: the selects and the model button on the
  // first, the action buttons on the second, so wide screens stop clipping the
  // trailing actions off the panel edge (92831a3).
  const controlLine = resting.controls[0];
  assert.ok(resting.controls.every((middle) => Math.abs(middle - controlLine) <= 1),
    `selects and the model button share the top row, got ${JSON.stringify(resting.controls)}`);
  const actionLine = resting.actions[0]!;
  assert.ok(resting.actions.every((middle) => middle !== null && Math.abs(middle - actionLine) <= 2),
    `action labels share the row below the controls, got ${JSON.stringify(resting.actions)}`);
  assert.ok(actionLine > controlLine + 8,
    `the actions sit on their own row (${actionLine}) below the controls (${controlLine})`);
});

test("the composer shortcut puts the cursor in the message box", async () => {
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card", { hasText: "Thread-Based Agent Builder" }).click();
  await page.locator("#messageInput:enabled").waitFor();
  await page.getByTestId("recent-sessions-open-button").focus();
  await page.keyboard.press("Control+Alt+I");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "messageInput", "the shortcut lands in the composer");

  // The composer sits on the bottom edge, so its badge hangs above the row: below it
  // would fall off the screen.
  const badge = await holdingModifiers(() => page.evaluate(() => {
    const host = document.querySelector("#composer .composer-row")!;
    const mark = host.querySelector(".shortcut-hint")!;
    const box = mark.getBoundingClientRect();
    return { key: mark.textContent, above: box.bottom <= host.getBoundingClientRect().top + 1 };
  }));
  assert.equal(badge.key, "I", "the composer advertises its key");
  assert.ok(badge.above, "the composer badge sits above the row so the window edge never clips it");
});

test("chat shortcuts focus selectors and open actions", async () => {
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card", { hasText: "Thread-Based Agent Builder" }).click();
  await page.locator("#modelButton:enabled").waitFor();
  for (const [key, id] of [["H", "chatNodeSelect"], ["A", "chatHarnessSelect"], ["T", "reasoningLevelSelect"]]) {
    await page.keyboard.press(`Control+Alt+${key}`);
    assert.equal(await page.evaluate(() => document.activeElement?.id), id, `${key} focuses ${id}`);
  }
  for (const [key, target, close] of [["M", "model-dialog", "model-dialog-close-button"], ["X", "terminal-dialog", "terminal-close-button"], ["E", "rename-session-input", null]]) {
    await page.keyboard.press(`Control+Alt+${key}`);
    await page.getByTestId(target!).waitFor({ timeout: 5000 });
    if (close) await page.getByTestId(close).click();
    else await page.keyboard.press("Escape");
    await page.getByTestId(target!).waitFor({ state: "hidden" });
  }
  await page.route(/\/api\/browser\/(?:sessions|profiles)\?/, (route) => route.fulfill({
    json: route.request().url().includes("/profiles?") ? { profiles: [] } : { sessions: [] },
  }));
  await page.keyboard.press("Control+Alt+B");
  await page.locator("#browserPanel").waitFor();
  await page.getByTestId("browser-close-viewer").click();
  await page.keyboard.press("Control+Alt+S");
  await page.getByTestId("cron-dialog").waitFor();
  await page.getByTestId("cron-close").click();
  await page.context().grantPermissions(["notifications"]);
  const before = await page.getByTestId("chat-notify-button").getAttribute("aria-pressed");
  await page.keyboard.press("Control+Alt+Y");
  await page.locator(`#notifyButton[aria-pressed="${before === "true" ? "false" : "true"}"]`).waitFor();
  await page.keyboard.press("Control+Alt+J");
  await page.locator("#canvasPanel").waitFor();
  const frame = page.locator(".canvas-pane:visible iframe").first().contentFrame();
  await frame.getByTestId("chat-message-input").click();
  await frame.locator("#modelButton:enabled").waitFor();
  await page.keyboard.press("Control+Alt+M");
  await frame.getByTestId("model-dialog").waitFor();
  assert.equal(await page.getByTestId("model-dialog").isVisible(), false, "canvas shortcuts target the pane, not the background chat");
  await page.keyboard.press("Control+Alt+H");
  assert.equal(await frame.locator("body").evaluate(() => document.activeElement?.closest("dialog")?.id), "modelDialog", "an open pane dialog keeps keyboard focus");
  await page.keyboard.press("Escape");
});

test("the shortcut journey produces no console errors", () => {
  assert.deepEqual(consoleErrors, []);
});
