import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
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
  browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? "chrome", headless: process.env.HEADED !== "1" });
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

test("header icons wear the shortcut that opens them", async () => {
  await signIn();
  assert.equal(await hint("recent-sessions-open-button").innerText(), "\u2318K", "recents shows its chord");
  assert.equal(await hint("pending-reviews-open-button").innerText(), "\u2318\u21e7R", "reviews shows its chord");
  assert.equal(await hint("running-conversations-open-button").innerText(), "\u2318\u21e7O", "running shows its chord");
  assert.equal(await hint("settings-open-button").innerText(), "\u2318,", "settings shows its chord");
  assert.equal(await hint("projects-open-canvas-button").innerText(), "\u2318\u21e7V", "the canvas launch shows its chord");
});

test("canvas shares the top toolbar with larger icons and readable shortcut badges", async () => {
  const tools = page.locator("#projectsPanel .project-actions");
  assert.equal(await tools.locator("#openCanvasButton").count(), 1, "Canvas belongs beside Settings");
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  for (const button of await tools.locator("button").all()) {
    const icon = await button.locator("svg").boundingBox();
    assert.ok(icon && icon.width >= 20, `toolbar icon must be at least 20px, got ${icon?.width}`);
    const font = await button.locator(".shortcut-hint").evaluate((badge) => parseFloat(getComputedStyle(badge).fontSize));
    assert.ok(font >= 16, `shortcut needs at least 16px, got ${font}`);
  }
  const rows = await tools.locator("button").evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().top));
  assert.ok(rows.every((top) => top === rows[0]), "all six toolbar buttons fit on one row");
});

test("chat controls advertise shortcuts except safeguards", async () => {
  for (const id of ["chat-node-select", "chat-harness-select", "chat-model-button", "chat-reasoning-select", "chat-open-terminal-button", "chat-notify-button", "chat-add-to-canvas-button", "chat-rename-button"]) {
    const control = page.getByTestId(id);
    const host = await control.evaluate((element) => element.closest("[data-shortcut-hint]")?.getAttribute("data-shortcut-hint"));
    assert.ok(host, `${id} needs a shortcut hint`);
  }
  assert.equal(await page.getByTestId("chat-safeguards-button").getAttribute("data-shortcut-hint"), null);
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
  await page.keyboard.press("Meta+Shift+KeyO");
  await page.getByTestId("running-conversations-dialog").waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await page.getByTestId("running-conversations-dialog").waitFor({ state: "hidden" });
  await page.keyboard.press("Meta+Comma");
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
  assert.equal(await hint("recent-sessions-open-button").innerText(), "\u2303J", "the badge follows the saved chord");

  // Put the defaults back so the other tests keep seeing them.
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-dialog").waitFor({ state: "visible" });
  await page.getByTestId("settings-tab-shortcuts").click();
  await page.getByTestId("canvas-keymap-reset-button").click();
  await page.getByTestId("canvas-keymap-save-button").click();
  await page.getByTestId("canvas-keymap-status").filter({ hasText: "Saved." }).waitFor();
  await page.getByTestId("settings-cancel-button").click();
  await page.getByTestId("settings-dialog").waitFor({ state: "hidden" });
  assert.equal(await hint("recent-sessions-open-button").innerText(), "\u2318K");
});

test("the board icon sits between running and settings, and the desktop conversations header hides both board and running", async () => {
  const order = await page.locator("#projectsPanel .project-actions button[data-testid]")
    .evaluateAll((nodes) => nodes.map((element) => element.getAttribute("data-testid")));
  assert.deepEqual(order, [
    "pending-reviews-open-button",
    "recent-sessions-open-button",
    "running-conversations-open-button",
    "projects-open-board-button",
    "projects-open-canvas-button",
    "settings-open-button",
  ]);
  assert.equal(await page.locator("#chatsPanel [data-testid='chats-open-board-button']").count(), 0,
    "the conversations header no longer carries a board button");
  assert.equal(await page.locator("#chatsPanel [data-testid='chats-running-conversations-open-button']").isVisible(), false,
    "the desktop conversations header hides the mobile running button");
  assert.equal(await hint("projects-open-board-button").innerText(), "\u2318\u21e7B",
    "the board advertises its keyboard shortcut");
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

test("the chat toolbar keeps its controls and shortcut badges on shared lines", async () => {
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card", { hasText: "Thread-Based Agent Builder" }).click();
  await page.locator("#modelButton:enabled").waitFor();
  // Wide enough that the toolbar keeps every control on one row, so alignment is unambiguous.
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

  const layout = await page.evaluate(() => {
    const bar = document.querySelector("#chatToolbar")!;
    return {
      badges: [...bar.querySelectorAll(".shortcut-hint")]
        .map((badge) => badge.getBoundingClientRect())
        .filter((box) => box.height > 0)
        .map((box) => Math.round(box.bottom * 10) / 10),
      controls: ["#chatNodeSelect", "#chatHarnessSelect", "#modelButton", "#reasoningLevelSelect"]
        .map((selector) => bar.querySelector(selector)!.getBoundingClientRect())
        .map((box) => Math.round((box.top + box.bottom) / 2 * 10) / 10),
      // The action buttons carry their label as bare text, so the text run itself is measured.
      actions: ["#safeguardsButton", "#openTerminalButton", "#notifyButton", "#addToCanvasButton", "#renameSessionButton"]
        .map((selector) => [...bar.querySelector(selector)!.childNodes]
          .find((child) => child.nodeType === Node.TEXT_NODE && child.textContent!.trim()))
        .map((text) => {
          if (!text) return null;
          const range = document.createRange();
          range.selectNode(text);
          const box = range.getBoundingClientRect();
          return Math.round((box.top + box.bottom) / 2 * 10) / 10;
        }),
    };
  });

  await page.setViewportSize({ width: 1440, height: 900 });

  assert.ok(layout.badges.length >= 7, `every toolbar control shows its badge, saw ${layout.badges.length}`);
  const badgeLine = layout.badges[0];
  assert.ok(layout.badges.every((bottom) => Math.abs(bottom - badgeLine) <= 1),
    `shortcut badges share one line, got ${JSON.stringify(layout.badges)}`);
  const controlLine = layout.controls[0];
  assert.ok(layout.controls.every((middle) => Math.abs(middle - controlLine) <= 1),
    `selects and the model button share one line, got ${JSON.stringify(layout.controls)}`);
  assert.ok(layout.actions.every((middle) => middle !== null && Math.abs(middle - controlLine) <= 2),
    `action labels sit on the control line (${controlLine}), got ${JSON.stringify(layout.actions)}`);
});

test("chat shortcuts focus selectors and open actions without touching safeguards", async () => {
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card", { hasText: "Thread-Based Agent Builder" }).click();
  await page.locator("#modelButton:enabled").waitFor();
  const safeguards = await page.getByTestId("chat-safeguards-button").getAttribute("aria-pressed");
  for (const [key, id] of [["N", "chatNodeSelect"], ["A", "chatHarnessSelect"], ["T", "reasoningLevelSelect"]]) {
    await page.keyboard.press(`Control+Alt+${key}`);
    assert.equal(await page.evaluate(() => document.activeElement?.id), id, `${key} focuses ${id}`);
  }
  for (const [key, target, close] of [["M", "model-dialog", "model-dialog-close-button"], ["X", "terminal-dialog", "terminal-close-button"], ["R", "rename-session-input", null]]) {
    await page.keyboard.press(`Control+Alt+${key}`);
    await page.getByTestId(target!).waitFor({ timeout: 5000 });
    if (close) await page.getByTestId(close).click();
    else await page.keyboard.press("Escape");
    await page.getByTestId(target!).waitFor({ state: "hidden" });
  }
  await page.context().grantPermissions(["notifications"]);
  const before = await page.getByTestId("chat-notify-button").getAttribute("aria-pressed");
  await page.keyboard.press("Control+Alt+Y");
  await page.locator(`#notifyButton[aria-pressed="${before === "true" ? "false" : "true"}"]`).waitFor();
  assert.equal(await page.getByTestId("chat-safeguards-button").getAttribute("aria-pressed"), safeguards);
  await page.keyboard.press("Control+Alt+V");
  await page.locator("#canvasPanel").waitFor();
  const frame = page.locator(".canvas-pane:visible iframe").first().contentFrame();
  await frame.getByTestId("chat-message-input").click();
  await frame.locator("#modelButton:enabled").waitFor();
  await page.keyboard.press("Control+Alt+M");
  await frame.getByTestId("model-dialog").waitFor();
  assert.equal(await page.getByTestId("model-dialog").isVisible(), false, "canvas shortcuts target the pane, not the background chat");
  await page.keyboard.press("Control+Alt+N");
  assert.equal(await frame.locator("body").evaluate(() => document.activeElement?.closest("dialog")?.id), "modelDialog", "an open pane dialog keeps keyboard focus");
  await page.keyboard.press("Escape");
});

test("the shortcut journey produces no console errors", () => {
  assert.deepEqual(consoleErrors, []);
});
