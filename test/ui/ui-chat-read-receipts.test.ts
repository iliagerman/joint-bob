// Read-receipt browser suite: opens a seeded transcript in a real Chrome and
// proves three things. Replayed messages show the wall-clock time they were
// recorded at, formatted by the browser's own locale and time zone. Replayed
// user messages render as already received by the agent (they sit in the
// agent's own transcript). Assistant messages the reader has never viewed
// carry an unread dot that clears — and persists a per-conversation watermark
// in localStorage — once the reader dwells at the bottom of the chat.
//
// Run with `npm run test:ui`.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { type Browser, type BrowserContext, type Page } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "../dev-nodes.js";

const PROJECT_NAME = "Internal Assistant";
const CONVERSATION_TITLE = "Scroll follow reference";
// The seeded transcript stamps turn N at 2026-08-30T09:00Z + N minutes.
const SEED_EPOCH_MS = Date.parse("2026-08-30T09:00:00.000Z");
const SEED_TURNS = 18;

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
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-read-receipts-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  server = await startDevNode(environment, node);

  browser = await launchChrome({ headless: process.env.HEADED !== "1" });
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

async function waitFor(predicate: () => Promise<boolean> | boolean, label: string, timeout = 15_000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - startedAt > timeout) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

async function openConversation(): Promise<void> {
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open], .project-card").first().waitFor({ timeout: 20_000 });
  if (await page.locator("#loginDialog[open]").isVisible().catch(() => false)) {
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
  }
  // A reload restores the previously open conversation by itself; a first visit
  // walks in through the project and conversation lists.
  const transcriptReady = page.getByText(`Scroll reference turn ${SEED_TURNS} of ${SEED_TURNS}`, { exact: false }).first();
  const restored = await transcriptReady.waitFor({ timeout: 5_000 }).then(() => true, () => false);
  if (!restored) {
    const sessionCard = page.locator(".session-card", { hasText: CONVERSATION_TITLE }).first();
    if (!(await sessionCard.isVisible().catch(() => false))) {
      await page.locator(".project-card", { hasText: PROJECT_NAME }).first().click();
    }
    await sessionCard.click();
    await transcriptReady.waitFor({ timeout: 20_000 });
  }
}

interface TranscriptReadState {
  stampCount: number;
  chatBubbleCount: number;
  firstStampIso: string;
  firstStampText: string;
  expectedTimeText: string;
  maxStampMs: number;
  userCount: number;
  receiptCount: number;
  receiptReadCount: number;
  assistantCount: number;
  dotCount: number;
}

/** One atomic read of the rendered transcript that also scrolls away from the bottom, so the dwell timer cannot clear the dots mid-measurement. */
function readTranscriptAndScrollAway(): Promise<TranscriptReadState> {
  return page.evaluate(() => {
    const chatBubbles = [...document.querySelectorAll("#messages .message.user, #messages .message.assistant")];
    const stamps = [...document.querySelectorAll<HTMLTimeElement>("#messages .message time.message-time")];
    const first = stamps[0];
    const box = document.querySelector<HTMLElement>("#messages");
    const state = {
      stampCount: stamps.length,
      chatBubbleCount: chatBubbles.length,
      firstStampIso: first ? first.dateTime : "",
      firstStampText: first ? first.textContent || "" : "",
      expectedTimeText: first ? new Date(first.dateTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "",
      maxStampMs: Math.max(0, ...stamps.map((stamp) => Date.parse(stamp.dateTime))),
      userCount: document.querySelectorAll("#messages .message.user").length,
      receiptCount: document.querySelectorAll("#messages .message.user .message-receipt").length,
      receiptReadCount: document.querySelectorAll('#messages .message.user .message-receipt[data-read="true"]').length,
      assistantCount: document.querySelectorAll("#messages .message.assistant").length,
      dotCount: document.querySelectorAll("#messages .message-unread-dot").length,
    };
    box.scrollTop = Math.floor(box.scrollHeight * 0.2);
    return state;
  });
}

function dotCount(): Promise<number> {
  return page.evaluate(() => document.querySelectorAll("#messages .message-unread-dot").length);
}

let firstView: TranscriptReadState;

test("replayed messages show their recorded time in the browser's zone and user messages read as received", async () => {
  await openConversation();
  firstView = await readTranscriptAndScrollAway();

  assert.equal(firstView.stampCount, firstView.chatBubbleCount, "every replayed chat bubble carries a timestamp");
  const firstMs = Date.parse(firstView.firstStampIso);
  assert.ok(firstMs > SEED_EPOCH_MS && firstMs <= SEED_EPOCH_MS + SEED_TURNS * 60_000,
    `the stamp is the recorded seed time, not "now" (got ${firstView.firstStampIso})`);
  assert.ok(firstView.firstStampText.includes(firstView.expectedTimeText),
    `the visible stamp "${firstView.firstStampText}" shows the browser-local time "${firstView.expectedTimeText}"`);
  // A message from a past day names its date, not just a clock time.
  assert.ok(firstView.firstStampText.trim().length > firstView.expectedTimeText.length,
    `an old message includes its date, got "${firstView.firstStampText}"`);

  assert.ok(firstView.userCount > 0, "the seeded transcript has user messages");
  assert.equal(firstView.receiptCount, firstView.userCount, "every user message carries a receipt");
  assert.equal(firstView.receiptReadCount, firstView.userCount, "replayed user messages read as received by the agent");
});

test("assistant messages start unread and the dots clear after dwelling at the bottom, persisting the watermark", async () => {
  assert.ok(firstView.assistantCount > 0, "the seeded transcript has assistant messages");
  assert.equal(firstView.dotCount, firstView.assistantCount, "with no watermark every assistant message is unread");

  // Away from the bottom the dots must persist well past the dwell interval.
  await new Promise((resolve) => setTimeout(resolve, 2600));
  assert.equal(await dotCount(), firstView.dotCount, "dots persist while the reader is away from the bottom");

  await page.evaluate(() => {
    const box = document.querySelector<HTMLElement>("#messages");
    box.scrollTop = box.scrollHeight;
  });
  await waitFor(async () => (await dotCount()) === 0, "unread dots to clear after dwelling at the bottom");

  // The watermark lands in the account's server-side preferences, so any
  // signed-in device shares the read state. The save runs in the background,
  // hence the poll.
  const readMarks = (): Promise<Record<string, number>> => page.evaluate(() =>
    fetch("/api/preferences", { cache: "no-store" }).then((response) => response.json()).then((preferences) => preferences.conversationLastRead ?? {}));
  await waitFor(async () => Object.keys(await readMarks()).length === 1, "the watermark to reach the server");
  const values = Object.values(await readMarks());
  assert.equal(values[0], firstView.maxStampMs, "the watermark is the newest rendered message time");
});

test("a caught-up conversation reopens with no unread dots", async () => {
  await openConversation();
  assert.equal(await dotCount(), 0, "no unread dots after the transcript was already viewed");

  assert.equal(consoleErrors.length, 0, `no console errors, got: ${consoleErrors.join("; ")}`);
  assert.deepEqual(failedResponses, [], "no failed responses");
});
