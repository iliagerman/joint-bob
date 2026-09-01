// A prompt typed while the agent is working must survive a reload. It used to
// live only in this page's DOM, so refreshing the browser lost a message the
// user had already sent. Only a real browser can prove it comes back.
//
// Run with `npm run test:ui`.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "../dev-nodes.js";
import { gatedClaude } from "../queued-prompt-harness.js";

const CONVERSATION = "Makor deployment information";

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let server: ChildProcess;
let browser: Browser;
let context: BrowserContext;
let page: Page;

/** The fake CLI parks each turn until its own gate file appears, so a second
 * prompt can be typed while the first turn is genuinely still running. */
function releaseTurn(prompt: string): Promise<void> {
  return writeFile(`${path.join(root, "gate")}.${prompt}`, "");
}

async function openConversation(): Promise<void> {
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator(".session-card", { hasText: CONVERSATION }).first().click();
  await page.getByTestId("chat-message-input").waitFor({ timeout: 20_000 });
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-queue-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  const executable = await gatedClaude(root);
  server = await startDevNode(environment, node, {
    JOINT_BOB_FAKE_INVOCATIONS: path.join(root, "invocations.log"),
    JOINT_BOB_FAKE_GATE: path.join(root, "gate"),
    JOINT_BOB_FAKE_PROJECTS_ROOT: path.join(environment.home, ".claude", "projects"),
  });
  const session = await signIn(environment, node);
  const headers = { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" };
  const current = await (await fetch(`${node.url}/api/settings`, { headers: { Cookie: session.cookie } })).json() as Record<string, Record<string, unknown>>;
  const settings = { ...current, claude: { ...current.claude, executable } };
  const saved = await fetch(`${node.url}/api/settings`, { method: "PUT", headers, body: JSON.stringify(settings) });
  assert.ok(saved.ok, "the node accepts the fake Claude executable");

  browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? "chrome", headless: process.env.HEADED !== "1" });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
  page = await context.newPage();
  page.on("console", (message) => { if (message.type() === "error") console.error("console:", message.text()); });

  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 20_000 });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByText("Internal Assistant", { exact: true }).waitFor({ timeout: 20_000 });
}, { timeout: 120_000 });

after(async () => {
  await Promise.all(["hold the line", "and this one waits"].map((prompt) => releaseTurn(prompt).catch(() => undefined)));
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

test("a prompt typed while the agent is working is still on the conversation after a reload", async () => {
  await openConversation();
  await page.getByTestId("chat-message-input").fill("hold the line");
  await page.keyboard.press("Enter");
  await page.locator(".message.user", { hasText: "hold the line" }).first().waitFor({ timeout: 20_000 });

  await page.getByTestId("chat-message-input").fill("and this one waits");
  await page.keyboard.press("Enter");
  const queued = page.locator(".message.user.queued", { hasText: "and this one waits" });
  await queued.first().waitFor({ timeout: 20_000 });
  assert.match(await queued.first().innerText(), /queued/i);

  // The app reopens the conversation it was last in, so the reload lands back
  // in this chat without walking the project list again.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("chat-message-input").waitFor({ timeout: 20_000 });
  await page.locator(".message", { hasText: "Deployment information for the Makor environment." }).first().waitFor({ timeout: 20_000 });

  // The bubble is rebuilt from the conversation, not from anything this page
  // was holding, so it is still there and still reads as pending.
  const restored = page.locator(".message.user.queued", { hasText: "and this one waits" });
  await restored.first().waitFor({ timeout: 20_000 });
  assert.equal(await restored.count(), 1, "the queued prompt is shown exactly once");
}, { timeout: 120_000 });
