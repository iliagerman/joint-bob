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

test("the board icon sits between running and settings, and the conversations header drops both board and running", async () => {
  const order = await page.locator("#projectsPanel .project-actions button[data-testid]")
    .evaluateAll((nodes) => nodes.map((element) => element.getAttribute("data-testid")));
  assert.deepEqual(order, [
    "projects-panel-collapse-button",
    "pending-reviews-open-button",
    "recent-sessions-open-button",
    "running-conversations-open-button",
    "projects-open-board-button",
    "settings-open-button",
  ]);
  assert.equal(await page.locator("#chatsPanel [data-testid='chats-open-board-button']").count(), 0,
    "the conversations header no longer carries a board button");
  assert.equal(await page.locator("#chatsPanel [data-testid='chats-running-conversations-open-button']").count(), 0,
    "the conversations header no longer carries a running button");
  assert.equal(await page.locator("[data-testid='projects-open-board-button'] .shortcut-hint").count(), 0,
    "the board has no keyboard shortcut, so it wears no badge");
});

test("the projects brand owns a row and the action buttons sit on the row below it", async () => {
  const brand = await page.locator("#projectsPanel .brand").boundingBox();
  const actions = await page.locator("#projectsPanel .project-actions").boundingBox();
  assert.ok(brand && actions, "both header rows rendered");
  assert.ok(actions!.y >= brand!.y + brand!.height - 1, `actions row (y=${actions!.y}) starts below the brand row (ends ${brand!.y + brand!.height})`);

  // Neither the name nor the subtitle may be truncated now that the buttons moved away.
  const cut = await page.locator("#projectsPanel .brand-copy")
    .evaluate((node) => [...node.children].some((child) => child.scrollWidth > child.clientWidth + 1));
  assert.equal(cut, false, "the app name and subtitle fit their row");
});

test("the shortcut journey produces no console errors", () => {
  assert.deepEqual(consoleErrors, []);
});
