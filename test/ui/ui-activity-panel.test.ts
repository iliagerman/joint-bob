// Activity panel browser suite: tool calls leave the main thread for a collapsible
// sidebar, the thread keeps one marker per turn, and the sidebar shows a running
// summary the conversation's node keeps after each message. The summary writer and
// Claude are stand-ins, so the test drives the real server, socket and rendering.
//
// Run with `npm run test:file -- test/ui/ui-activity-panel.test.ts`.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { type Browser, type BrowserContext, type Page } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { api, projectNamed, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "../dev-nodes.js";
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
let calls: string;

/** Every summary the stand-in writer was asked for, oldest first. */
async function summaryCalls(): Promise<Array<{ material: string; instructions: string; run: { harnessId: string; source: string } }>> {
  return (await readFile(calls, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** A stand-in Claude Code: streams one answer and appends the turn to the transcript, as the real one does. */
async function installFakeClaude(transcripts: string): Promise<string> {
  const fake = path.join(root, "fake-claude.mjs");
  await writeFile(fake, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
let input = "";
await new Promise((resolve) => process.stdin.on("data", (chunk) => { input += chunk; }).on("end", resolve));
const args = process.argv.slice(2);
const supplied = args.indexOf("--session-id");
const sessionId = supplied >= 0 ? args[supplied + 1] : args[args.indexOf("--resume") + 1];
let prompt = input.trim() || "a request";
for (const line of input.split("\\n")) {
  try {
    const content = JSON.parse(line).message?.content;
    const text = typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("");
    if (text.trim()) prompt = text.trim();
  } catch {}
}
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }));
const answer = "Row counts match on every table.";
for (const chunk of answer.match(/.{1,8}/g)) {
  console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: chunk } } }));
  await new Promise((resolve) => setTimeout(resolve, 150));
}
const stamp = new Date().toISOString();
appendFileSync(${JSON.stringify(transcripts)} + "/" + sessionId + ".jsonl", [
  { type: "user", uuid: sessionId + "-p-" + Date.now(), timestamp: stamp, message: { role: "user", content: [{ type: "text", text: prompt }] } },
  { type: "assistant", uuid: sessionId + "-a-" + Date.now(), timestamp: stamp, message: { role: "assistant", content: [{ type: "text", text: answer }] } },
].map((record) => JSON.stringify(record)).join("\\n") + "\\n");
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: answer }] } }));
console.log(JSON.stringify({ type: "result", is_error: false }));
`);
  await chmod(fake, 0o755);
  return fake;
}

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
  calls = path.join(root, "digest-calls.jsonl");
  const generator = path.join(root, "digest-generator.mjs");
  // A writer that ignores the format rules (a heading, a long code block) proves the panel still never scrolls sideways.
  await writeFile(generator, `import { appendFile } from "node:fs/promises";
export default async (input) => {
  await appendFile(${JSON.stringify(calls)}, JSON.stringify(input) + "\\n");
  const asked = /User: (.*)/.exec(input.material)?.[1] ?? "the work";
  return "**Goal** — " + asked + "\\n\\n## Done so far\\n- Rotated staging.pem\\n\\n\\\`\\\`\\\`json\\n{\\"apartment\\":\\"" + "x".repeat(400) + "\\"}\\n\\\`\\\`\\\`";
};
`);
  server = await startDevNode(environment, node, { JOINT_BOB_DIGEST_GENERATOR: generator });
  const project = projectNamed(node, PROJECT_NAME);
  const fake = await installFakeClaude(claudeProjectDir(project.path, path.join(environment.home, ".claude", "projects")));
  const admin = await signIn(environment, node);
  const current = (await api<{ pi: { executable: string; configPath: string; sessionPath: string }; claude: { configPath: string; sessionPath: string }; syncthing: { endpoint: string } }>(node, admin, "GET", "/settings")).body;
  const configured = await api(node, admin, "PUT", "/settings", {
    pi: { executable: current.pi.executable, configPath: current.pi.configPath, sessionPath: current.pi.sessionPath },
    claude: { executable: fake, configPath: current.claude.configPath, sessionPath: current.claude.sessionPath },
    syncthing: { endpoint: current.syncthing.endpoint },
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));

  browser = await launchChrome({ headless: process.env.HEADED !== "1" });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
  page = await context.newPage();
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(error.stack || error.message));
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

  // Landing on an idle conversation that has no summary spends no model call; the next answer writes one.
  await page.getByTestId("activity-summary-text").getByText("The summary is written after the agent's next answer.").waitFor({ timeout: 15_000 });
  assert.equal((await summaryCalls()).length, 0, "no summary is written just because the conversation opened");
  assert.equal(await page.getByTestId("activity-summary-model").innerText(), "Writer: automatic");
  await page.getByTestId("activity-summary-refresh").filter({ hasText: "Write summary" }).waitFor();
  // Opening the panel yourself is asking to see the summary, so it is written.
  await page.getByTestId("activity-panel-close").click();
  await page.getByTestId("chat-activity-toggle").click();
  await page.getByTestId("activity-summary-text").locator("strong", { hasText: "Goal" }).waitFor({ timeout: 15_000 });
  const [firstCall] = await summaryCalls();
  assert.equal(firstCall.material, "User: Rotate the staging certificates\n\nAssistant: Checking the certificates first.\n\nAssistant: Rotated staging.pem.", "the writer reads what was said, not the tool output");
  assert.deepEqual([firstCall.run.harnessId, firstCall.run.source], ["claude", "conversation"], "automatic without a routing classifier uses the conversation's agent");
  assert.equal(await page.getByTestId("activity-summary-refresh").innerText(), "Update summary");
  assert.match(await page.getByTestId("activity-summary-text").innerText(), /Rotate the staging certificates/);
  assert.match(await page.getByTestId("activity-summary-status").innerText(), /1 turn/);
  // Headings and long code wrap inside the panel: nothing scrolls sideways.
  const widths = await page.getByTestId("activity-summary").evaluate((box) => ({ box: [box.scrollWidth, box.clientWidth], text: [box.querySelector(".activity-summary-text").scrollWidth, box.querySelector(".activity-summary-text").clientWidth] }));
  assert.ok(widths.box[0] <= widths.box[1] && widths.text[0] <= widths.text[1] + 1, `the summary does not scroll sideways (${JSON.stringify(widths)})`);

  // A long turn's steps fill the panel, and the summary keeps its room above them.
  await page.evaluate(async () => {
    const transcript = await import("/app/chat-transcript.js");
    for (let index = 0; index < 300; index += 1) {
      const bubble = transcript.appendToolMessage("Bash", `long-${index}`, 0, Date.now(), { target: `step ${index}` });
      transcript.updateToolMessage(bubble, "ok", "Done", false, 10);
    }
  });
  await waitFrames();
  const summaryBox = await page.getByTestId("activity-summary").boundingBox();
  assert.ok(summaryBox && summaryBox.height >= 120, `the summary is not squeezed by a long steps list (${summaryBox?.height}px)`);
  assert.equal(await page.getByTestId("activity-summary-text").locator("strong", { hasText: "Goal" }).isVisible(), true);
  const stepsBox = await page.getByTestId("activity-list").boundingBox();
  assert.ok(stepsBox && summaryBox && stepsBox.y >= summaryBox.y + summaryBox.height, "the steps list scrolls below the summary");
  // The summary stays at the top while the steps scroll.
  await page.getByTestId("activity-list").evaluate((list) => { list.scrollTop = list.scrollHeight; });
  await waitFrames();
  assert.deepEqual(await page.getByTestId("activity-summary").boundingBox(), summaryBox, "scrolling the steps leaves the summary where it is");
  assert.equal(await page.getByTestId("activity-summary-text").locator("strong", { hasText: "Goal" }).isVisible(), true);
  // It collapses to its header line and opens again.
  await page.getByTestId("activity-summary-toggle").click();
  assert.equal(await page.getByTestId("activity-summary-text").isVisible(), false);
  assert.equal(await page.getByTestId("activity-summary-toggle").isVisible(), true, "the collapsed summary keeps its header");
  assert.match(await page.getByTestId("activity-summary-status").innerText(), /1 turn/);
  const collapsed = await page.getByTestId("activity-summary").boundingBox();
  assert.ok(collapsed && collapsed.height < 50, `collapsed to one line (${collapsed?.height}px)`);
  await page.getByTestId("activity-summary-toggle").click();
  await page.getByTestId("activity-summary-text").locator("strong", { hasText: "Goal" }).waitFor();

  // Who writes summaries, and when, is this machine's setting in Settings → Conversations.
  const modelButton = page.getByTestId("activity-summary-model");
  await modelButton.click();
  const harnessPicker = page.getByTestId("settings-summary-harness");
  await harnessPicker.locator("option[value='pi']").waitFor({ state: "attached", timeout: 15_000 });
  assert.equal(await page.getByTestId("settings-summary-updates").inputValue(), "each-message", "after each message is the default");
  assert.equal(await harnessPicker.inputValue(), "automatic", "automatic is the default writer");
  assert.equal(await page.getByTestId("settings-summary-model").isVisible(), false);
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/conversation-summary/settings") && response.request().method() === "PUT");
  await harnessPicker.selectOption("pi");
  assert.equal((await saved).status(), 200);
  await page.getByTestId("settings-summary-model").waitFor();
  const chosenModel = await page.getByTestId("settings-summary-model").evaluate((select: HTMLSelectElement) => select.selectedOptions[0]?.dataset.modelId || select.value);
  await page.waitForFunction((expected) => document.querySelector("[data-testid='activity-summary-model']")?.textContent === expected, `Writer: ${chosenModel}`);
  const stored = await page.evaluate(() => fetch("/api/conversation-summary/settings").then((response) => response.json()));
  assert.deepEqual([stored.node.writer.source, stored.node.writer.harnessId], ["fixed", "pi"]);
  const restored = page.waitForResponse((response) => response.url().endsWith("/api/conversation-summary/settings") && response.request().method() === "PUT");
  await harnessPicker.selectOption("automatic");
  assert.equal((await restored).status(), 200);
  await page.keyboard.press("Escape");
  await page.locator("#settingsDialog[open]").waitFor({ state: "detached" });

  // Steps stay inspectable in the panel.
  await panel.getByText("Bash", { exact: true }).first().click();
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

  // While a turn runs, the thread itself ends with a row naming what is happening.
  const working = page.locator("#messages").getByTestId("live-activity");
  const lastInThread = () => page.locator("#messages").evaluate((box) => box.lastElementChild?.getAttribute("data-testid"));
  await page.evaluate(async () => (await import("/app/socket.js")).handleSocketPayload({ type: "agent_start" }));
  await working.waitFor();
  assert.match(await working.innerText(), /Working…/);
  await page.evaluate(async () => (await import("/app/socket.js")).handleSocketPayload({ type: "toolStart", toolName: "Bash", toolCallId: "live-1", toolTarget: { target: "npm run migrate" } }));
  assert.match(await working.innerText(), /Running Bash · npm run migrate/);
  await page.evaluate(async () => {
    const { handleSocketPayload } = await import("/app/socket.js");
    handleSocketPayload({ type: "toolEnd", toolName: "Bash", toolCallId: "live-1", text: "migrated" });
    handleSocketPayload({ type: "assistantFinal", text: "Migration 42 finished; checking row counts." });
  });
  assert.match(await working.innerText(), /Working…/);
  assert.equal(await lastInThread(), "live-activity", "new answers land above the working row");
  await working.click();
  await page.waitForFunction(() => document.querySelector("#activityList .activity-group.highlighted"));
  await page.evaluate(async () => (await import("/app/socket.js")).handleSocketPayload({ type: "agent_end" }));
  await working.waitFor({ state: "detached" });

  // A real answer: the conversation's node writes the summary after it, with the panel closed.
  await page.locator(".session-card", { hasText: LIVE_TITLE }).first().click();
  await page.locator("#messages").getByText("Migration 42 is running.").waitFor({ timeout: 20_000 });
  await page.getByTestId("activity-panel-close").click();
  await panel.waitFor({ state: "hidden" });
  const before = (await summaryCalls()).length;
  await page.getByTestId("chat-message-input").fill("Check the row counts");
  await page.getByTestId("chat-send-button").click();
  await page.locator("#messages").getByText("Row counts match on every table.").first().waitFor({ timeout: 30_000 });
  for (const until = Date.now() + 20_000; (await summaryCalls()).length === before && Date.now() < until;) await new Promise((resolve) => setTimeout(resolve, 250));
  const liveCalls = (await summaryCalls()).slice(before);
  assert.equal(liveCalls.length, 1, "one summary after the answer, though nobody had the panel open");
  assert.match(liveCalls[0].material, /User: Run the database migration[\s\S]*User: Check the row counts\n\nAssistant: Row counts match on every table\.$/);
  // The node pushed it to the page while the panel was closed; opening the panel shows it as is.
  await page.getByTestId("activity-summary-text").getByText("Run the database migration").waitFor({ state: "attached", timeout: 15_000 });
  await page.getByTestId("chat-activity-toggle").click();
  await page.getByTestId("activity-summary-text").getByText("Run the database migration").waitFor();
  await page.waitForTimeout(1_500);
  assert.equal((await summaryCalls()).length, before + 1, "opening the panel on an up-to-date summary writes nothing more");

  // On a phone the panel floats over the thread instead of squeezing it.
  await page.setViewportSize({ width: 390, height: 844 });
  await waitFrames();
  assert.equal(await panel.evaluate((element) => getComputedStyle(element).position), "absolute");

  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(failedResponses, []);
});
