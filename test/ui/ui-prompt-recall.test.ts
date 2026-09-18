// Prompt recall browser suite: the up arrow must walk the prompts a conversation
// already contains, not only the ones typed since the page opened. The history is
// rebuilt from the transcript the server delivers, so only a real browser opening
// a real conversation proves it. Source assertions cannot: they pass against a
// build where the arrow key does nothing at all.
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
const MAKOR = { title: "Makor deployment information", prompt: "Deployment information for the Makor environment." };
const FOLLOW_REQUESTS = { title: "Pending follow request review", prompt: "Pending follow request review." };

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let server: ChildProcess;
let browser: Browser;
let context: BrowserContext;
let page: Page;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-recall-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  server = await startDevNode(environment, node);

  browser = await launchChrome({ headless: process.env.HEADED !== "1" });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
  page = await context.newPage();
  page.on("console", (message) => { if (message.type() === "error") console.error("console:", message.text()); });

  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 20_000 });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByText(PROJECT_NAME, { exact: true }).waitFor({ timeout: 20_000 });
}, { timeout: 120_000 });

after(async () => {
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

async function openConversation(title: string, firstMessage: string): Promise<void> {
  await page.locator(".project-card", { hasText: PROJECT_NAME }).first().click();
  await page.locator(".session-card", { hasText: title }).first().click();
  await page.getByTestId("chat-message-input").waitFor({ timeout: 20_000 });
  // Recall is seeded from the transcript, so it is only ready once that has rendered.
  await page.locator(".message.user", { hasText: firstMessage }).first().waitFor({ timeout: 20_000 });
}

function composerValue(): Promise<string> {
  return page.getByTestId("chat-message-input").inputValue();
}

async function pressInComposer(key: string): Promise<void> {
  await page.getByTestId("chat-message-input").focus();
  await page.keyboard.press(key);
}

test("the up arrow recalls a conversation's own prompts from its loaded transcript", async () => {
  await openConversation(MAKOR.title, MAKOR.prompt);
  assert.equal(await composerValue(), "", "the composer opens empty");

  // The whole point of the fix: this conversation's prompt was never typed in
  // this page, it came back from the transcript.
  await pressInComposer("ArrowUp");
  assert.equal(await composerValue(), MAKOR.prompt, "the up arrow recalls the transcript's newest prompt");

  // Walking forward past the newest entry returns the empty line it started on.
  await pressInComposer("ArrowDown");
  assert.equal(await composerValue(), "", "the down arrow returns the line the recall started from");
}, { timeout: 120_000 });

test("recall stashes a half-typed line and hands it back", async () => {
  await openConversation(MAKOR.title, MAKOR.prompt);
  await page.getByTestId("chat-message-input").fill("half typed");

  // A draft keeps its own caret movement first: the caret sits at the end, so the
  // first press only walks it to the start of the line, as any text box does. The
  // second press has nowhere left to go and reaches the history.
  await pressInComposer("ArrowUp");
  assert.equal(await composerValue(), "half typed", "the first press moves the caret, it does not recall");
  await pressInComposer("ArrowUp");
  assert.equal(await composerValue(), MAKOR.prompt, "the draft gives way to the recalled prompt");

  await pressInComposer("ArrowDown");
  assert.equal(await composerValue(), "half typed", "the half-typed line comes back untouched");
}, { timeout: 120_000 });

test("each conversation recalls only its own prompts", async () => {
  await openConversation(MAKOR.title, MAKOR.prompt);
  await pressInComposer("ArrowUp");
  assert.equal(await composerValue(), MAKOR.prompt);

  await openConversation(FOLLOW_REQUESTS.title, FOLLOW_REQUESTS.prompt);
  await pressInComposer("ArrowUp");
  assert.equal(await composerValue(), FOLLOW_REQUESTS.prompt, "the other conversation's prompt never leaks in");
}, { timeout: 120_000 });

test("a reload rebuilds recall from the transcript", async () => {
  await openConversation(MAKOR.title, MAKOR.prompt);
  // The app reopens the conversation it was last in, so the reload lands back here.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("chat-message-input").waitFor({ timeout: 20_000 });
  await page.locator(".message.user", { hasText: MAKOR.prompt }).first().waitFor({ timeout: 20_000 });

  await pressInComposer("ArrowUp");
  assert.equal(await composerValue(), MAKOR.prompt, "recall survives a reload");
}, { timeout: 120_000 });
