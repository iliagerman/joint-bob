import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { type Browser, type Page } from "playwright-core";
import { seedDevEnvironment, startDevNode, stopDevNode, type DevEnvironment } from "../dev-nodes.js";
import { launchChrome } from "./launch-chrome.js";

let root: string;
let environment: DevEnvironment;
let server: ChildProcess;
let browser: Browser;
let page: Page;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-sharing-ui-"));
  environment = await seedDevEnvironment(root, 1);
  server = await startDevNode(environment, environment.nodes[0]);
  browser = await launchChrome({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  await page.goto(environment.nodes[0].url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  const appState = await page.evaluateHandle(async () => (await import("/app/state.js")).state);
  try { await page.waitForFunction((state) => state.preferencesLoaded, appState); }
  finally { await appState.dispose(); }
}, { timeout: 120_000 });

after(async () => {
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

test("Share copies the open conversation's identity and its link overrides saved navigation on mobile", async () => {
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator(".session-card", { hasText: "Thread-Based Agent Builder" }).first().click();
  await page.waitForFunction(() => !(document.querySelector("#messageInput") as HTMLTextAreaElement).disabled);
  const expected = await page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    return { conversationId: state.activeConversationId, projectId: state.activeConversationProjectId, nodeId: state.activeNodeId };
  });
  assert.ok(expected.conversationId);
  await page.evaluate(`
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text) => { document.body.dataset.copiedLink = text; },
    } });
  `);
  await page.getByTestId("chat-share-button").click();
  const copied = await page.locator("body").getAttribute("data-copied-link");
  assert.ok(copied);
  const link = new URL(copied);
  assert.equal(link.searchParams.get("sessionId"), expected.conversationId);
  assert.equal(link.searchParams.get("projectId"), expected.projectId);
  assert.equal(link.searchParams.get("nodeId"), expected.nodeId);
  assert.equal(link.searchParams.has("sessionPath"), false, "links must not expose local transcript paths");
  await page.evaluate(async () => {
    const { api } = await import("/app/api.js");
    await api("/api/preferences", { method: "PUT", body: JSON.stringify({ mobileView: "projects", activeSessionPath: null, activeSessionId: null }) });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(link.toString());
  await page.locator("body.view-chat").waitFor();
  await page.waitForFunction(() => !(document.querySelector("#messageInput") as HTMLTextAreaElement).disabled);
  await page.waitForFunction(() => document.querySelector("#sessionTitle")?.textContent?.includes("Thread-Based Agent Builder"));
  assert.match(await page.locator("#sessionTitle").textContent() || "", /Thread-Based Agent Builder/);
  await page.locator("body:not(.booting).view-chat #chatPanel").waitFor({ state: "visible" });
  assert.equal(await page.locator("#chatPanel").isVisible(), true, "saved Projects view must not hide the linked conversation");
});

test("native sharing uses the conversation link and reports share or clipboard failures", async () => {
  await page.evaluate(`
    Object.defineProperty(navigator, "share", { configurable: true, value: async (data) => {
      document.body.dataset.sharedConversation = JSON.stringify(data);
    } });
  `);
  await page.getByTestId("chat-more-button").click();
  await page.getByTestId("chat-share-button").click();
  const shared = JSON.parse(await page.locator("body").getAttribute("data-shared-conversation") || "null");
  assert.match(shared.title, /Thread-Based Agent Builder/);
  assert.ok(new URL(shared.url).searchParams.get("sessionId"));
  await page.evaluate(`Object.defineProperty(navigator, "share", { configurable: true, value: async () => { throw new Error("Synthetic share rejection"); } });`);
  await page.getByTestId("chat-more-button").click();
  await page.getByTestId("chat-share-button").click();
  await page.getByText("Failed to share link: Synthetic share rejection", { exact: true }).waitFor();
  await page.evaluate(`
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async () => { throw new Error("Synthetic clipboard rejection"); },
    } });
  `);
  await page.getByTestId("chat-more-button").click();
  await page.getByTestId("chat-share-button").click();
  await page.getByText("Failed to copy link: Synthetic clipboard rejection", { exact: true }).waitFor();
});

test("the manifest's New Conversation shortcut opens the wizard without sending a message", async () => {
  const manifest = await (await page.request.get(`${environment.nodes[0].url}/manifest.webmanifest`)).json();
  const shortcut = manifest.shortcuts.find((entry: { name: string }) => entry.name === "New Conversation");
  assert.ok(shortcut);
  assert.notEqual(shortcut.url, manifest.start_url, "New Conversation must have its own launch intent");
  await page.goto(new URL(shortcut.url, environment.nodes[0].url).toString());
  await page.getByTestId("new-session-name-input").waitFor({ state: "visible" });
  assert.equal(await page.locator("#newSessionNameDialog").isVisible(), true);
  assert.equal(await page.getByTestId("new-session-name-input").inputValue(), "");
  await page.getByTestId("new-session-name-cancel-button").click();
});
