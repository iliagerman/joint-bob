// Scroll-follow browser suite: drives a real Chrome against a seeded node and
// proves the chat pane's follow behaviour. Open on the newest message, follow
// growth while the reader is at the bottom, release when they scroll away, and
// resume when they return. Growth is triggered the way production triggers it:
// transcript records landing on disk (the cross-node sync path re-renders the
// conversation) and a fake Claude executable streaming text deltas over the
// live socket.
//
// Run with `npm run test:ui`.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { appendFile, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { api, projectNamed, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "../dev-nodes.js";
import { claudeProjectDir } from "../../src/session-paths.js";

const PROJECT_NAME = "Internal Assistant";
const CONVERSATION_TITLE = "Scroll follow reference";
const CONVERSATION_ID = "5f8c3a71-9b2e-4d67-a3c1-72e5d8f04b19";
const BOTTOM_THRESHOLD_PX = 32;
// The seeded transcript stamps turn N at 2026-08-30T09:00Z + N minutes.
const SEED_EPOCH_MS = Date.parse("2026-08-30T09:00:00.000Z");

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let server: ChildProcess;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const consoleErrors: string[] = [];
const failedResponses: string[] = [];

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-scroll-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  server = await startDevNode(environment, node);

  browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? "chrome", headless: process.env.HEADED !== "1" });
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  page = await context.newPage();
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
  });
}, { timeout: 120_000 });

after(async () => {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(root, "final.png") }).catch(() => undefined);
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

interface ScrollMetrics { scrollTop: number; scrollHeight: number; clientHeight: number; messageCount: number }

function metrics(): Promise<ScrollMetrics> {
  return page.evaluate(() => {
    const box = document.querySelector<HTMLElement>("#messages");
    return {
      scrollTop: box.scrollTop,
      scrollHeight: box.scrollHeight,
      clientHeight: box.clientHeight,
      messageCount: document.querySelectorAll("#messages .message").length,
    };
  });
}

function distanceFromBottom(state: ScrollMetrics): number {
  return state.scrollHeight - state.scrollTop - state.clientHeight;
}

function setScrollTop(value: number): Promise<void> {
  return page.evaluate((top) => {
    const box = document.querySelector<HTMLElement>("#messages");
    box.scrollTop = top;
  }, value);
}

async function waitFrames(): Promise<void> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function waitFor(predicate: () => Promise<boolean> | boolean, label: string, timeout = 15_000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - startedAt > timeout) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

let externalTurnIndex = 0;

/** Appends one user/assistant turn pair to the seeded Claude transcript on disk, the way Syncthing delivers another node's work. */
async function appendExternalTurnPair(marker: string): Promise<void> {
  const project = projectNamed(node, PROJECT_NAME);
  const projectsRoot = path.join(environment.home, ".claude", "projects");
  const transcript = path.join(claudeProjectDir(project.path, projectsRoot), `${CONVERSATION_ID}.jsonl`);
  const records = (["user", "assistant"] as const).map((role, offset) => ({
    type: role,
    uuid: `${CONVERSATION_ID}-ext-${externalTurnIndex}-${offset}`,
    cwd: project.path,
    // Far past the seeded turns so ordering by file position and by time agree.
    timestamp: new Date(SEED_EPOCH_MS + (1_000 + externalTurnIndex * 2 + offset) * 60_000).toISOString(),
    message: { role, content: [{ type: "text", text: `${marker} (${role}), arrived from disk, turn ${externalTurnIndex + 1}.` }] },
  }));
  externalTurnIndex += 1;
  await appendFile(transcript, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

async function waitForTurnPair(marker: string, previousCount: number): Promise<void> {
  await page.getByText(`${marker} (user)`, { exact: false }).first().waitFor({ timeout: 15_000 });
  await page.getByText(`${marker} (assistant)`, { exact: false }).first().waitFor({ timeout: 15_000 });
  await waitFor(async () => (await metrics()).messageCount >= previousCount + 2, `transcript re-render including ${marker}`);
  await waitFrames();
}

async function openConversation(): Promise<void> {
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 20_000 });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByText(PROJECT_NAME, { exact: true }).waitFor({ timeout: 20_000 });
  await page.locator(".project-card", { hasText: PROJECT_NAME }).first().click();
  await page.locator(".session-card", { hasText: CONVERSATION_TITLE }).first().click();
  await page.getByText("Scroll reference turn 18 of 18", { exact: false }).waitFor({ timeout: 20_000 });
  await waitFrames();
}

test("opening a conversation with a long transcript lands on the newest message", async () => {
  await openConversation();

  const state = await metrics();
  assert.ok(state.scrollHeight > state.clientHeight * 2, `transcript must overflow the pane (scrollHeight ${state.scrollHeight}, clientHeight ${state.clientHeight})`);
  assert.ok(distanceFromBottom(state) < BOTTOM_THRESHOLD_PX, `pane opens at the bottom, ${distanceFromBottom(state)}px away`);
});

test("records arriving on disk while the reader is at the bottom keep the pane pinned", async () => {
  const before = await metrics();
  await appendExternalTurnPair("Disk sync marker one");
  await waitForTurnPair("Disk sync marker one", before.messageCount);

  const after = await metrics();
  assert.ok(distanceFromBottom(after) < BOTTOM_THRESHOLD_PX, `pane stays at the bottom after new records arrive, ${distanceFromBottom(after)}px away`);
});

test("scrolling away releases follow until the reader returns to the bottom", async () => {
  // Leave the bottom: follow must release.
  const start = await metrics();
  await setScrollTop(Math.floor(start.scrollHeight * 0.3));
  await waitFrames();

  // New records arrive: the view must stay anchored where the reader is.
  const anchoredBefore = await metrics();
  assert.ok(distanceFromBottom(anchoredBefore) > BOTTOM_THRESHOLD_PX, "reader is away from the bottom");
  await appendExternalTurnPair("Disk sync marker two");
  await waitForTurnPair("Disk sync marker two", anchoredBefore.messageCount);
  const anchoredAfter = await metrics();
  assert.ok(
    Math.abs(anchoredAfter.scrollTop - anchoredBefore.scrollTop) <= 8,
    `view stays anchored while scrolled away (was ${anchoredBefore.scrollTop}, now ${anchoredAfter.scrollTop})`,
  );
  assert.ok(distanceFromBottom(anchoredAfter) > distanceFromBottom(anchoredBefore), "new records grow below the anchored view");

  // Return to the bottom: follow must resume.
  await setScrollTop(anchoredAfter.scrollHeight);
  await waitFrames();
  const resumed = await metrics();
  assert.ok(distanceFromBottom(resumed) < BOTTOM_THRESHOLD_PX, "reader is back at the bottom");

  await appendExternalTurnPair("Disk sync marker three");
  await waitForTurnPair("Disk sync marker three", resumed.messageCount);
  const pinnedAgain = await metrics();
  assert.ok(distanceFromBottom(pinnedAgain) < BOTTOM_THRESHOLD_PX, `pane follows again once back at the bottom, ${distanceFromBottom(pinnedAgain)}px away`);
});

async function installFakeClaude(): Promise<string> {
  const fake = path.join(root, "fake-claude.mjs");
  await writeFile(fake, `#!/usr/bin/env node
await new Promise((resolve) => process.stdin.on('end', resolve).resume());
const args = process.argv.slice(2);
const supplied = args.indexOf('--session-id');
const resumed = args.indexOf('--resume');
const sessionId = supplied >= 0 ? args[supplied + 1] : args[resumed + 1];
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }));
const filler = ('Streaming follow check line. ').repeat(140);
for (const chunk of filler.match(/.{1,70}/gs) ?? []) {
  console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: chunk } } }));
  await new Promise((resolve) => setTimeout(resolve, 40));
}
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: filler }] } }));
console.log(JSON.stringify({ type: 'result', is_error: false }));
`);
  await chmod(fake, 0o755);
  return fake;
}

async function configureClaudeExecutable(fake: string): Promise<void> {
  const session = await signIn(environment, node);
  const settings = await api<{ pi: { executable: string; configPath: string; sessionPath: string }, claude: { executable: string; configPath: string; sessionPath: string }, syncthing: { endpoint: string } }>(node, session, "GET", "/settings");
  const current = settings.body;
  const put = await api(node, session, "PUT", "/settings", {
    pi: { executable: current.pi.executable, configPath: current.pi.configPath, sessionPath: current.pi.sessionPath },
    claude: { executable: fake, configPath: current.claude.configPath, sessionPath: current.claude.sessionPath },
    syncthing: { endpoint: current.syncthing.endpoint },
  });
  assert.equal(put.status, 200, "settings accept the fake Claude executable");
}

function lastBubbleLength(): Promise<number> {
  return page.evaluate(() => {
    const bubbles = document.querySelectorAll("#messages .message");
    return bubbles.length ? bubbles[bubbles.length - 1].innerText.length : 0;
  });
}

async function startLongStream(prompt: string, label: string): Promise<void> {
  await page.getByTestId("chat-message-input").fill(prompt);
  await page.getByTestId("chat-send-button").click();
  await page.getByText(prompt, { exact: false }).first().waitFor({ timeout: 10_000 });
  await waitFor(async () => (await lastBubbleLength()) > 1_200, label);
}

async function waitForStreamEnd(): Promise<void> {
  await waitFor(async () => {
    const size = await lastBubbleLength();
    await new Promise((resolve) => setTimeout(resolve, 250));
    return size === await lastBubbleLength() && size > 1_200;
  }, "stream to finish");
}

test("a live streaming reply follows the reader, releases on scroll-away, and resumes at the bottom", async () => {
  await configureClaudeExecutable(await installFakeClaude());
  await setScrollTop((await metrics()).scrollHeight);
  await waitFrames();

  await startLongStream("please stream a long reply once", "streamed reply to start growing");
  const duringStream = await metrics();
  assert.ok(distanceFromBottom(duringStream) < BOTTOM_THRESHOLD_PX, `pane follows the live stream at the bottom, ${distanceFromBottom(duringStream)}px away`);

  const box = await page.locator("#messages").boundingBox();
  assert.ok(box, "messages pane is on screen");
  await page.mouse.move(box.x + box.width / 2, box.y + 120);
  await page.mouse.wheel(0, -600);
  await waitFor(async () => distanceFromBottom(await metrics()) > 200, "pane to release after scrolling away");
  const releasedAt = await metrics();
  await waitForStreamEnd();
  const streamEnd = await metrics();
  assert.ok(Math.abs(streamEnd.scrollTop - releasedAt.scrollTop) <= 8, "finished stream does not yank the released view to the bottom");
  assert.ok(distanceFromBottom(streamEnd) > 200, "reader stays where they scrolled to while the stream finished");

  await setScrollTop(streamEnd.scrollHeight);
  await waitFrames();
  await startLongStream("please stream a long reply twice", "second streamed reply to start growing");
  const resumedStream = await metrics();
  assert.ok(distanceFromBottom(resumedStream) < BOTTOM_THRESHOLD_PX, `pane follows the second stream once back at the bottom, ${distanceFromBottom(resumedStream)}px away`);

  assert.equal(consoleErrors.length, 0, `no console errors, got: ${consoleErrors.join("; ")}`);
  assert.deepEqual(failedResponses, [], "no failed responses");
});
