// A queued prompt the harness refuses to start (for example Kiro's monthly quota)
// used to stay silently "Queued": the server's promptFailed event was ignored by
// the page. The reason must now appear on the bubble itself.
//
// Run with `npm run test:ui`.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { type Browser, type Page } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";

let root: string;
let server: ChildProcess;
let browser: Browser;
let page: Page;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-queued-failure-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  server = await startDevNode(environment, node);
  const session = await signIn(environment, node);
  browser = await launchChrome({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  const [name, value] = session.cookie.split("=");
  await context.addCookies([{ name, value, url: node.url }]);
  page = await context.newPage();
  await page.goto(node.url);
  await page.getByText("Internal Assistant", { exact: true }).waitFor();
});

after(async () => {
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

async function renderQueued(): Promise<void> {
  await page.evaluate(`(async () => {
    const transcript = await import("/app/chat-transcript.js");
    const { state } = await import("/app/state.js");
    transcript.clearChat();
    window.queueCommands = [];
    state.socket = { readyState: WebSocket.OPEN, send: (raw) => window.queueCommands.push(JSON.parse(raw)) };
    document.querySelector("#chatPanel").style.display = "flex";
    transcript.markMessageQueued(transcript.appendMessage("user", "browse the dev site"), "q-1", "browse the dev site", null, 3);
  })()`);
}

async function deliver(payload: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (value) => {
    const { handleSocketPayload } = await import("/app/socket.js");
    handleSocketPayload(value);
  }, payload);
}

test("a failed start shows the harness's reason on the queued bubble", async () => {
  await renderQueued();
  await deliver({ type: "promptFailed", queueId: "q-1", error: "The monthly usage limit has been reached" });
  const bubble = page.locator('[data-queue-id="q-1"]');
  const reason = bubble.getByTestId("queued-message-error");
  await reason.waitFor();
  assert.equal(await reason.innerText(), "The monthly usage limit has been reached");
  assert.ok(await bubble.evaluate((element) => element.classList.contains("queued")), "the prompt stays queued for a retry");
});

test("a later failure replaces the earlier reason instead of stacking", async () => {
  await renderQueued();
  await deliver({ type: "promptFailed", queueId: "q-1", error: "first reason" });
  await deliver({ type: "promptFailed", queueId: "q-1", error: "second reason" });
  const reasons = page.locator('[data-queue-id="q-1"] [data-testid="queued-message-error"]');
  assert.equal(await reasons.count(), 1);
  assert.equal(await reasons.first().innerText(), "second reason");
});

test("the reason disappears once the prompt starts", async () => {
  await renderQueued();
  await deliver({ type: "promptFailed", queueId: "q-1", error: "The monthly usage limit has been reached" });
  await page.getByTestId("queued-message-error").waitFor();
  await deliver({ type: "promptStarted", queueId: "q-1" });
  assert.equal(await page.getByTestId("queued-message-error").count(), 0);
});
