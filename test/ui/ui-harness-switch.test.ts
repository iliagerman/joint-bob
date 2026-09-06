import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "../dev-nodes.js";

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let server: ChildProcess;
let browser: Browser;
let context: BrowserContext;
let page: Page;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-harness-switch-ui-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  server = await startDevNode(environment, node);
  await signIn(environment, node);
  browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? "chrome", headless: process.env.HEADED !== "1" });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  page = await context.newPage();
}, { timeout: 120_000 });

after(async () => {
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

test("switching harness mid-conversation keeps one conversation with a visible segment seam", async () => {
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();

  const title = "Thread-Based Agent Builder";
  const conversation = page.locator(".session-card", { hasText: title }).first();
  await conversation.waitFor({ timeout: 20_000 });
  await conversation.click();
  await page.waitForFunction(() => !(document.querySelector("#messageInput") as HTMLTextAreaElement).disabled);
  const messagesBefore = await page.locator(".message").count();
  assert.ok(messagesBefore > 0, "the Pi transcript rendered before the switch");

  // Pinning names the logical conversation, so the pin outlives a harness switch.
  const pinnedRow = page.locator("#sessionList .list-row", { hasText: title }).first();
  await pinnedRow.getByTestId("session-pin-button").click();
  await page.locator("#sessionList .list-row.pinned", { hasText: title }).first().waitFor({ timeout: 10_000 });

  await page.getByTestId("chat-harness-select").selectOption("claude");
  await page.getByTestId("harness-switch-notice").filter({ hasText: "Switched to Claude" }).waitFor({ timeout: 20_000 });

  // The original transcript stays; the seam opens a tinted Claude segment.
  assert.ok((await page.locator(".message").count()) >= messagesBefore, "existing messages survive the switch");
  const segment = page.locator('.harness-segment[data-harness="claude"]');
  await segment.waitFor({ timeout: 10_000 });

  // One conversation, still one row, now driven by Claude.
  await page.locator(".session-card", { hasText: title }).first().waitFor({ timeout: 20_000 });
  assert.equal(await page.locator("#sessionList .list-row", { hasText: title }).count(), 1, "the switched conversation is still a single row");
  assert.equal(await page.getByTestId("chat-harness-select").inputValue(), "claude");

  // A reload before the first Claude turn reopens the whole conversation: the
  // Pi history plus an empty but visible Claude seam.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().waitFor({ timeout: 20_000 });
  await page.locator(".session-card", { hasText: title }).first().click();
  await page.waitForFunction(() => !(document.querySelector("#messageInput") as HTMLTextAreaElement).disabled);
  await page.getByTestId("harness-switch-notice").filter({ hasText: "Switched to Claude" }).waitFor({ timeout: 20_000 });
  await page.locator('.harness-segment[data-harness="claude"]').waitFor({ timeout: 10_000 });
  assert.ok((await page.locator(".message").count()) > 0, "the Pi history rendered after the reload");
  assert.equal(await page.locator("#sessionList .list-row", { hasText: title }).count(), 1);
  await page.locator("#sessionList .list-row.pinned", { hasText: title }).first().waitFor({ timeout: 10_000 });
});
