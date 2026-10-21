// Activity panel browser suite: tool calls leave the main thread for a collapsible
// sidebar, the thread keeps one marker per run of steps, and the sidebar shows a
// running summary of the conversation. The summary model is a stand-in module,
// so the test exercises the real route, store and rendering without an agent.
//
// Run with `npm run test:file -- test/ui/ui-activity-panel.test.ts`.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { type Browser, type BrowserContext, type Page } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { projectNamed, seedDevEnvironment, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "../dev-nodes.js";
import { claudeProjectDir } from "../../src/session-paths.js";

const PROJECT_NAME = "Infra Scripts";
const CONVERSATION_TITLE = "Certificate rotation";
const CONVERSATION_ID = "7b1d2e3f-4051-4b6c-9d7e-8f9a0b1c2d3e";
const LIVE_TITLE = "Database migration";
const LIVE_ID = "8c2e3f40-5162-4c7d-8e9f-0a1b2c3d4e5f";

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let server: ChildProcess;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const consoleErrors: string[] = [];
const failedResponses: string[] = [];
let summaryWrites = 0;
const summaryBodies: Array<{ conversation?: { harnessId: string; provider?: string; modelId?: string } }> = [];

async function writeTranscript(): Promise<void> {
  const project = projectNamed(node, PROJECT_NAME);
  const directory = claudeProjectDir(project.path, path.join(environment.home, ".claude", "projects"));
  await writeFile(path.join(directory, `${LIVE_ID}.jsonl`), `${[
    { type: "ai-title", aiTitle: LIVE_TITLE, cwd: project.path, timestamp: "2026-09-02T10:00:00.000Z" },
    { type: "user", uuid: `${LIVE_ID}-0`, cwd: project.path, timestamp: "2026-09-02T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "Run the database migration" }] } },
    { type: "assistant", uuid: `${LIVE_ID}-1`, cwd: project.path, timestamp: "2026-09-02T10:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "Migration 42 is running." }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const transcript = path.join(directory, `${CONVERSATION_ID}.jsonl`);
  const at = (index: number) => new Date(Date.parse("2026-09-01T10:00:00Z") + index * 2_000).toISOString();
  const record = (role: "user" | "assistant", index: number, content: unknown[]) => ({ type: role, uuid: `${CONVERSATION_ID}-${index}`, cwd: project.path, timestamp: at(index), message: { role, content } });
  const records = [
    { type: "ai-title", aiTitle: CONVERSATION_TITLE, cwd: project.path, timestamp: at(0) },
    record("user", 0, [{ type: "text", text: "Rotate the staging certificates" }]),
    record("assistant", 1, [{ type: "text", text: "Checking the certificates first." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls certs" } }]),
    record("user", 2, [{ type: "tool_result", tool_use_id: "t1", content: "staging.pem\nproduction.pem" }]),
    record("assistant", 3, [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "certs/staging.pem" } }]),
    record("user", 4, [{ type: "tool_result", tool_use_id: "t2", content: "-----BEGIN CERTIFICATE-----" }]),
    record("assistant", 5, [{ type: "text", text: "Rotated staging.pem." }]),
  ];
  await writeFile(transcript, `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-activity-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  await writeTranscript();
  const generator = path.join(root, "digest-generator.mjs");
  await writeFile(generator, 'export default async () => "**Goal** — rotate the staging certificates.\\n\\n**Done so far**\\n- Rotated staging.pem";\n');
  server = await startDevNode(environment, node, { JOINT_BOB_DIGEST_GENERATOR: generator });

  browser = await launchChrome({ headless: process.env.HEADED !== "1" });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
  page = await context.newPage();
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(error.stack || error.message));
  page.on("request", (request) => {
    if (request.method() !== "POST" || !request.url().endsWith("/digest")) return;
    summaryWrites += 1;
    summaryBodies.push(JSON.parse(request.postData() || "{}"));
  });
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
  });
}, { timeout: 120_000 });

after(async () => {
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

async function waitFrames(): Promise<void> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test("tool calls live in the activity panel, the thread keeps a marker, and the summary shows", async () => {
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 20_000 });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: PROJECT_NAME }).first().click();
  await page.locator(".session-card", { hasText: CONVERSATION_TITLE }).first().click();
  await page.locator("#messages").getByText("Rotated staging.pem.").waitFor({ timeout: 20_000 });
  await waitFrames();

  // The thread: the prompt, one line counting the turn's steps, then what the agent said. No tool bubbles.
  assert.equal(await page.locator("#messages .tool-output").count(), 0, "no tool bubble stays in the thread");
  const marker = page.locator("#messages").getByTestId("activity-marker");
  assert.equal(await marker.count(), 1, "one marker per turn, not one per run of steps");
  assert.match(await marker.innerText(), /2 steps · Bash · Read/);
  const order = await page.locator("#messages").evaluate((box) => [...box.querySelectorAll(".message.user, .message.assistant, [data-testid='activity-marker']")]
    .map((node) => node.matches(".message.user") ? "prompt" : node.textContent?.includes("Checking") ? "intro" : node.textContent?.includes("Rotated") ? "answer" : "marker"));
  assert.deepEqual(order, ["prompt", "marker", "intro", "answer"], "the marker sits under the prompt that started the turn");
  // Only the turn's newest answer carries the model line; the earlier one keeps copy in its own row.
  assert.equal(await page.locator("#messages").getByTestId("assistant-attribution").count(), 1);
  const intro = page.locator("#messages .message.assistant", { hasText: "Checking" });
  assert.equal(await intro.evaluate((element) => element.classList.contains("quiet-answer")), true);
  assert.equal(await intro.locator(".message-meta").getByTestId("message-copy-button").count(), 1);

  // A wide window opens the panel beside the thread, not over it.
  const panel = page.getByTestId("activity-panel");
  await panel.waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("chat-activity-toggle").getAttribute("aria-expanded"), "true");
  assert.equal(await panel.locator(".tool-output").count(), 2);
  assert.equal(await panel.locator(".activity-group-prompt").innerText(), "Rotate the staging certificates", "a group is headed by its turn's prompt");
  const [messagesBox, panelBox] = await Promise.all([page.locator("#messages").boundingBox(), panel.boundingBox()]);
  assert.ok(messagesBox && panelBox && messagesBox.x + messagesBox.width <= panelBox.x + 1, `thread (${JSON.stringify(messagesBox)}) ends where the panel (${JSON.stringify(panelBox)}) begins`);
  assert.ok(panelBox.width >= 280, `panel is readable (${panelBox.width}px)`);

  // Landing on an idle conversation with the panel already open spends no model call.
  await page.getByTestId("activity-summary-text").getByText("No summary yet.").waitFor({ timeout: 15_000 });
  assert.equal(summaryWrites, 0, "no summary is written just because the conversation opened");
  await page.getByTestId("activity-summary-refresh").filter({ hasText: "Write summary" }).waitFor();
  // Opening the panel yourself is asking to see the summary, so it is written.
  await page.getByTestId("activity-panel-close").click();
  await page.getByTestId("chat-activity-toggle").click();
  await page.getByTestId("activity-summary-text").locator("strong", { hasText: "Goal" }).waitFor({ timeout: 15_000 });
  assert.equal(summaryWrites, 1);
  assert.equal(summaryBodies[0].conversation?.harnessId, "claude", "the summary follows the conversation's agent by default");
  assert.equal(await page.getByTestId("activity-summary-refresh").innerText(), "Update summary");
  assert.match(await page.getByTestId("activity-summary-text").innerText(), /rotate the staging certificates/);
  assert.match(await page.getByTestId("activity-summary-status").innerText(), /1 turn/);

  // The model that writes summaries is named in the panel and chosen in Settings.
  const modelButton = page.getByTestId("activity-summary-model");
  assert.match(await modelButton.innerText(), /^Model: as conversation/);
  await modelButton.click();
  const harnessPicker = page.getByTestId("settings-summary-harness");
  await harnessPicker.locator("option[value='pi']").waitFor({ state: "attached", timeout: 15_000 });
  assert.equal(await harnessPicker.inputValue(), "", "Same as conversation is the default");
  assert.equal(await page.getByTestId("settings-summary-model").isVisible(), false);
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/preferences") && response.request().method() === "PUT");
  await harnessPicker.selectOption("pi");
  assert.equal((await saved).status(), 200);
  await page.getByTestId("settings-summary-model").waitFor();
  const chosenModel = await page.getByTestId("settings-summary-model").evaluate((select: HTMLSelectElement) => select.selectedOptions[0]?.dataset.modelId || select.value);
  assert.equal(await modelButton.innerText(), `Model: ${chosenModel}`);
  const preferences = await page.evaluate(() => fetch("/api/preferences").then((response) => response.json()));
  assert.equal(preferences.summaryModel?.harnessId, "pi");
  await page.keyboard.press("Escape");
  await page.locator("#settingsDialog[open]").waitFor({ state: "detached" });

  // Steps stay inspectable in the panel.
  await panel.getByText("Bash", { exact: true }).click();
  await panel.getByText("production.pem").waitFor();

  // Collapsing hands the width back and is remembered.
  await page.getByTestId("activity-panel-close").click();
  await panel.waitFor({ state: "hidden" });
  assert.equal(await page.getByTestId("chat-activity-toggle").getAttribute("aria-expanded"), "false");
  const widened = await page.locator("#messages").boundingBox();
  assert.ok(widened && messagesBox && widened.width > messagesBox.width + 200, "the thread takes the freed width");

  // The marker reopens the panel on its group.
  await marker.click();
  await panel.waitFor({ state: "visible" });
  await waitFrames();
  assert.equal(await panel.locator(".activity-group.highlighted").count(), 1);

  // Control+Option+Shift+S shows and collapses the panel, and the button says so.
  assert.equal(await page.getByTestId("chat-activity-toggle").locator(".shortcut-hint").innerText(), "⇧S");
  await page.keyboard.press("Control+Alt+Shift+KeyS");
  await panel.waitFor({ state: "hidden" });
  await page.keyboard.press("Control+Alt+Shift+KeyS");
  await panel.waitFor({ state: "visible" });

  // A conversation the agent is working in gets its summary from the agent's progress, without a click.
  await page.locator(".session-card", { hasText: LIVE_TITLE }).first().click();
  await page.locator("#messages").getByText("Migration 42 is running.").waitFor({ timeout: 20_000 });
  await page.getByTestId("activity-summary-text").getByText("No summary yet.").waitFor({ timeout: 15_000 });
  assert.equal(summaryWrites, 1, "landing on an idle conversation writes nothing");
  await page.evaluate(async () => {
    const { handleSocketPayload } = await import("/app/socket.js");
    handleSocketPayload({ type: "agent_start" });
    handleSocketPayload({ type: "assistantFinal", text: "Migration 42 finished; checking row counts." });
  });
  await page.getByTestId("activity-summary-text").locator("strong", { hasText: "Goal" }).waitFor({ timeout: 15_000 });
  assert.equal(summaryWrites, 2);
  await page.evaluate(async () => (await import("/app/socket.js")).handleSocketPayload({ type: "agent_end" }));

  // On a phone the panel floats over the thread instead of squeezing it.
  await page.setViewportSize({ width: 390, height: 844 });
  await waitFrames();
  assert.equal(await panel.evaluate((element) => getComputedStyle(element).position), "absolute");

  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(failedResponses, []);
});
