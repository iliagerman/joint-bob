// Activity panel browser suite: tool calls leave the main thread for a collapsible
// sidebar, the thread keeps one marker per turn, and the sidebar shows a running
// summary the conversation's node keeps after each message, statistics of the steps and
// skills, and the skills the summary writer suggests. The summary writer and Claude are
// stand-ins, so the test drives the real server, socket and rendering.
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
const answer = prompt.includes("Create a reusable skill draft")
  ? JSON.stringify({ name: "cert-renewal", description: "Use when rotating staging certificates.", instructions: "Check expiration. Renew staging first. Verify the new certificate before deploying." })
  : "Row counts match on every table.";
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
    record("assistant", 1, [{ type: "text", text: "Checking the certificates first." }, { type: "tool_use", id: "t0", name: "Skill", input: { skill: "cert-tools" } }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls certs" } }]),
    record("user", 2, [{ type: "tool_result", tool_use_id: "t0", content: "Launching skill: cert-tools" }, { type: "tool_result", tool_use_id: "t1", content: "staging.pem\nproduction.pem" }]),
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
  // It also suggests a new skill, and one the conversation already loaded, which is dropped.
  await writeFile(generator, `import { appendFile } from "node:fs/promises";
export default async (input) => {
  await appendFile(${JSON.stringify(calls)}, JSON.stringify(input) + "\\n");
  const asked = /User: (.*)/.exec(input.material)?.[1] ?? "the work";
  return "**Goal** — " + asked + "\\n\\n## Done so far\\n- Rotated staging.pem\\n\\n\\\`\\\`\\\`json\\n{\\"apartment\\":\\"" + "x".repeat(400) + "\\"}\\n\\\`\\\`\\\`\\n@@skills\\nnew cert-renewal — the renewal steps are repeated by hand\\nnew cert-tools — already loaded";
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

test("activity panel width is draggable and survives browser reopen", async () => {
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 20_000 });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: PROJECT_NAME }).first().click();
  await page.locator(".session-card", { hasText: CONVERSATION_TITLE }).first().click();
  const panel = page.getByTestId("activity-panel");
  await panel.waitFor({ state: "visible" });
  const handle = page.getByTestId("activity-panel-resize");
  await handle.waitFor({ state: "visible", timeout: 3000 });
  const original = (await panel.boundingBox())!;
  const grip = (await handle.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 100);
  await page.mouse.down();
  await page.mouse.move(grip.x - 100, grip.y + 100, { steps: 8 });
  await page.mouse.up();
  const wider = (await panel.boundingBox())!.width;
  assert.ok(wider > original.width + 90);
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  const savedWidth = (await panel.boundingBox())!.width;
  assert.ok(savedWidth < wider, "right arrow narrows the right-hand panel");
  const storage = await context.storageState();
  const reopened = await browser.newContext({ storageState: storage, viewport: page.viewportSize()! });
  try {
    const fresh = await reopened.newPage();
    await fresh.goto(node.url, { waitUntil: "domcontentloaded" });
    await fresh.locator(".project-card", { hasText: PROJECT_NAME }).first().click();
    await fresh.locator(".session-card", { hasText: CONVERSATION_TITLE }).first().click();
    await fresh.getByTestId("activity-panel").waitFor({ state: "visible" });
    assert.ok(Math.abs((await fresh.getByTestId("activity-panel").boundingBox())!.width - savedWidth) < 2);
    await fresh.setViewportSize({ width: 390, height: 844 });
    assert.equal(await fresh.getByTestId("activity-panel-resize").isVisible(), false);
  } finally {
    await reopened.close();
    await page.evaluate(() => localStorage.removeItem("joint-bob-activity-width"));
    await context.clearCookies();
  }
});

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
  assert.match(await marker.innerText(), /3 steps · Skill · Bash · Read/);
  const order = await page.locator("#messages").evaluate((box) => [...box.querySelectorAll(".message.user, .message.assistant, [data-testid='activity-marker']")]
    .map((node) => node.matches(".message.user") ? "prompt" : node.textContent?.includes("Checking") ? "intro" : node.textContent?.includes("Rotated") ? "answer" : "marker"));
  assert.deepEqual(order, ["prompt", "marker", "intro", "answer"], "the marker sits under the prompt that started the turn");
  // Only the turn's newest answer carries the model line; the earlier one keeps copy in its own row.
  assert.equal(await page.locator("#messages").getByTestId("assistant-attribution").count(), 1);
  const intro = page.locator("#messages .message.assistant", { hasText: "Checking" });
  assert.equal(await intro.evaluate((element) => element.classList.contains("quiet-answer")), true);
  assert.equal(await intro.locator(".message-meta").getByTestId("message-copy-button").count(), 1);
  // The skills the turn loaded sit beside its model line.
  const skillsChip = page.locator("#messages").getByTestId("message-skills");
  assert.equal(await skillsChip.count(), 1);
  assert.match(await skillsChip.innerText(), /skill\s*cert-tools/);
  assert.equal(await skillsChip.evaluate((chip) => chip.previousElementSibling?.getAttribute("data-testid")), "assistant-attribution");

  // A wide window opens the panel beside the thread, not over it.
  const panel = page.getByTestId("activity-panel");
  await panel.waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("chat-activity-toggle").getAttribute("aria-expanded"), "true");
  assert.equal(await panel.locator(".tool-output").count(), 3);
  assert.equal(await panel.locator(".activity-group-prompt").textContent(), "Rotate the staging certificates", "a group is headed by its turn's prompt");
  // The steps start collapsed under their count; the summary, statistics and suggestions start open.
  assert.equal(await page.getByTestId("activity-list").isVisible(), false, "steps are collapsed by default");
  assert.equal(await page.getByTestId("activity-steps-toggle").getAttribute("aria-expanded"), "false");
  assert.equal(await page.getByTestId("activity-steps-count").innerText(), "3");
  for (const section of ["activity-summary", "activity-stats", "activity-suggestions"]) assert.equal(await page.getByTestId(section).evaluate((details: HTMLDetailsElement) => details.open), true, `${section} is open`);
  // Statistics count the steps, their tools and the skills loaded.
  const stats = page.getByTestId("activity-stats-body");
  assert.equal(await page.getByTestId("activity-stats-status").innerText(), "3 steps · 1 skill");
  assert.deepEqual(await stats.locator(".activity-stat").evaluateAll((boxes) => boxes.map((box) => box.textContent)), ["1turn", "3steps", "0failed", "10sagent time"]);
  assert.deepEqual(await page.getByTestId("activity-stats-tools").getByTestId("activity-usage-row").evaluateAll((rows) => rows.map((row) => row.querySelector(".activity-usage-name")?.textContent + " " + row.querySelector(".activity-usage-count")?.textContent)), ["Bash 1", "Read 1", "Skill 1"]);
  assert.deepEqual(await page.getByTestId("activity-stats-skills").getByTestId("activity-usage-row").evaluateAll((rows) => rows.map((row) => row.querySelector(".activity-usage-name")?.textContent)), ["cert-tools"]);
  assert.equal(await page.getByTestId("activity-suggestions-body").innerText(), "Suggestions come with the next summary.");
  // The steps open under their header and collapse again.
  await page.getByTestId("activity-steps-toggle").click();
  await page.getByTestId("activity-list").waitFor();
  assert.equal(await page.getByTestId("activity-steps-toggle").getAttribute("aria-expanded"), "true");
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
  // The writer's suggestion shows in its own section; the skill already loaded is not suggested.
  const suggestion = page.getByTestId("activity-suggestion");
  await suggestion.first().waitFor();
  assert.equal(await suggestion.count(), 1);
  assert.match(await suggestion.innerText(), /new\s*cert-renewal\s*the renewal steps are repeated by hand/i);
  assert.equal(await page.getByTestId("activity-suggestions-status").innerText(), "1");
  // Generation first previews its source; only an explicitly reviewed save writes a skill.
  const skillPath = path.join(projectNamed(node, PROJECT_NAME).path, ".agents/skills/cert-renewal-reviewed/SKILL.md");
  const absent = async () => assert.rejects(readFile(skillPath), { code: "ENOENT" });
  await suggestion.getByTestId("activity-skill-generate").click();
  const draft = page.getByTestId("activity-skill-draft");
  await draft.getByTestId("skill-draft-context").getByText("Rotate the staging certificates", { exact: false }).waitFor();
  assert.match(await draft.innerText(), /Nothing is saved/);
  await absent();
  await draft.getByTestId("skill-draft-cancel").click();
  await suggestion.getByTestId("activity-skill-generate").click();
  await draft.getByTestId("skill-draft-start").click();
  await draft.getByTestId("skill-draft-status").getByText("Generating", { exact: false }).waitFor();
  await draft.getByTestId("skill-draft-save").waitFor({ timeout: 30_000 });
  assert.equal(await draft.getByTestId("skill-draft-description").inputValue(), "Use when rotating staging certificates.");
  await absent();
  // Regeneration also stays in the editor and does not install anything.
  await draft.getByTestId("skill-draft-regenerate").click();
  await draft.getByTestId("skill-draft-save").waitFor({ timeout: 30_000 });
  await absent();
  await draft.getByTestId("skill-draft-name").fill("cert-renewal-reviewed");
  await draft.getByTestId("skill-draft-description").fill("Use for reviewed certificate rotation.");
  await draft.getByTestId("skill-draft-instructions").fill("User edited: verify staging expiration, renew, and check the resulting certificate.");
  await draft.getByTestId("skill-draft-save").click();
  await draft.getByTestId("skill-draft-status").getByText("Saved", { exact: false }).waitFor();
  const savedSkill = await readFile(skillPath, "utf8");
  assert.match(savedSkill, /Use for reviewed certificate rotation/);
  assert.match(savedSkill, /User edited: verify staging/);
  assert.match(savedSkill, /name: cert-renewal-reviewed/);
  await assert.rejects(readFile(path.join(projectNamed(node, PROJECT_NAME).path, ".agents/skills/cert-renewal/SKILL.md")), { code: "ENOENT" });
  const admin = await signIn(environment, node);
  const saveEndpoint = `/projects/${projectNamed(node, PROJECT_NAME).id}/conversations/${CONVERSATION_ID}/skill-draft/save`;
  const approvedSkill = { approved: true, scope: "project", name: "cert-renewal-reviewed", description: "Replacement", instructions: "These instructions must never replace the reviewed skill." };
  assert.equal((await api(node, admin, "POST", saveEndpoint, approvedSkill)).status, 409, "save cannot overwrite an existing skill");
  assert.equal((await api(node, admin, "POST", saveEndpoint, { ...approvedSkill, approved: false })).status, 400, "save requires approval");
  assert.equal((await api(node, admin, "POST", saveEndpoint, { ...approvedSkill, name: "../escape" })).status, 400, "save rejects path traversal");
  assert.equal(await readFile(skillPath, "utf8"), savedSkill);
  await draft.getByTestId("skill-draft-cancel").click();
  // Statistics and suggestions collapse to their headers like the summary.
  await page.getByTestId("activity-stats-toggle").click();
  assert.equal(await stats.isVisible(), false);
  await page.getByTestId("activity-stats-toggle").click();
  await stats.waitFor();
  await page.getByTestId("activity-suggestions-toggle").click();
  assert.equal(await suggestion.isVisible(), false);
  await page.getByTestId("activity-suggestions-toggle").click();
  await suggestion.waitFor();
  // The panel scrolls as one column: no section sits in a scroll box of its own, so scrolling down
  // to the statistics shows all of them, none cut by a box's edge or hidden under a header.
  const body = page.getByTestId("activity-body");
  const overviewScroll = await page.getByTestId("activity-overview").evaluate((box) => [box.scrollHeight, box.clientHeight]);
  assert.ok(overviewScroll[0] <= overviewScroll[1] + 1, `the overview is not a scroll box of its own (${overviewScroll})`);
  await body.evaluate((box) => { box.scrollTop = box.scrollHeight; });
  await waitFrames();
  await stats.scrollIntoViewIfNeeded();
  const covered = await stats.evaluate((box) => [...box.querySelectorAll(".activity-stat, .activity-usage-row")].filter((item) => {
    const rect = item.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return !hit || !item.contains(hit);
  }).map((item) => item.textContent));
  assert.deepEqual(covered, [], "every figure and row of the statistics shows, uncovered");
  await body.evaluate((box) => { box.scrollTop = 0; });
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
  const writerPicker = page.getByTestId("settings-summary-writer");
  const harnessPicker = page.getByTestId("settings-summary-harness");
  await harnessPicker.locator("option[value='pi']").waitFor({ state: "attached", timeout: 15_000 });
  assert.equal(await page.getByTestId("settings-summary-updates").inputValue(), "each-message", "after each message is the default");
  assert.equal(await writerPicker.inputValue(), "automatic", "automatic is the default writer");
  for (const picker of ["settings-summary-harness", "settings-summary-model", "settings-summary-thinking"]) assert.equal(await page.getByTestId(picker).isVisible(), false, `${picker} belongs to a chosen writer`);
  // Choosing the writer here shows its agent, model and effort.
  const chosen = page.waitForResponse((response) => response.url().endsWith("/api/conversation-summary/settings") && response.request().method() === "PUT");
  await writerPicker.selectOption("fixed");
  assert.equal((await chosen).status(), 200);
  for (const picker of ["settings-summary-harness", "settings-summary-model", "settings-summary-thinking"]) await page.getByTestId(picker).waitFor();
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/conversation-summary/settings") && response.request().method() === "PUT");
  await harnessPicker.selectOption("pi");
  assert.equal((await saved).status(), 200);
  await page.getByTestId("settings-summary-model").waitFor();
  const chosenModel = await page.getByTestId("settings-summary-model").evaluate((select: HTMLSelectElement) => select.selectedOptions[0]?.dataset.modelId || select.value);
  await page.waitForFunction((expected) => document.querySelector("[data-testid='activity-summary-model']")?.textContent === expected, `Writer: ${chosenModel}`);
  const stored = await page.evaluate(() => fetch("/api/conversation-summary/settings").then((response) => response.json()));
  assert.deepEqual([stored.node.writer.source, stored.node.writer.harnessId], ["fixed", "pi"]);
  const restored = page.waitForResponse((response) => response.url().endsWith("/api/conversation-summary/settings") && response.request().method() === "PUT");
  await writerPicker.selectOption("automatic");
  assert.equal((await restored).status(), 200);
  assert.equal(await harnessPicker.isVisible(), false);

  // The summary instructions start as the built-in text; the admin's own text is saved on leaving the box.
  const instructionsBox = page.getByTestId("settings-summary-instructions");
  const instructionsStatus = page.getByTestId("settings-summary-instructions-status");
  assert.match(await instructionsBox.inputValue(), /^You keep a running summary of a conversation/);
  const skillBox = page.getByTestId("settings-skill-instructions");
  assert.match(await skillBox.inputValue(), /reusable insights/);
  assert.equal(await page.getByTestId("settings-skill-instructions-reset").isDisabled(), true);
  const skillSaved = page.waitForResponse((response) => response.url().endsWith("/api/conversation-summary/skill-instructions") && response.request().method() === "PUT");
  await skillBox.fill("Capture validated debugging lessons for teammates.");
  await skillBox.press("Tab");
  assert.equal((await skillSaved).status(), 200);
  await page.waitForFunction(() => document.querySelector("[data-testid='settings-skill-instructions-status']")?.textContent === "Saved · this machine's own instructions");
  const skillSettings = await page.evaluate(() => fetch("/api/conversation-summary/settings").then((response) => response.json()));
  assert.equal(skillSettings.skillInstructions.custom, "Capture validated debugging lessons for teammates.");
  const skillReset = page.waitForResponse((response) => response.url().endsWith("/api/conversation-summary/skill-instructions") && response.request().method() === "PUT");
  await page.getByTestId("settings-skill-instructions-reset").click();
  assert.equal((await skillReset).status(), 200);
  await page.waitForFunction(() => document.querySelector("[data-testid='settings-skill-instructions-status']")?.textContent === "Saved · built-in instructions");
  assert.match(await skillBox.inputValue(), /reusable insights/);
  assert.equal(await instructionsStatus.innerText(), "built-in instructions");
  assert.equal(await page.getByTestId("settings-summary-instructions-reset").isDisabled(), true);
  const instructionsSaved = page.waitForResponse((response) => response.url().endsWith("/api/conversation-summary/instructions") && response.request().method() === "PUT");
  await instructionsBox.fill("Summarize for a manager in three bullets.");
  await instructionsBox.press("Tab");
  assert.equal((await instructionsSaved).status(), 200);
  await page.waitForFunction(() => document.querySelector("[data-testid='settings-summary-instructions-status']")?.textContent === "Saved · this machine's own instructions");
  const withInstructions = await page.evaluate(() => fetch("/api/conversation-summary/settings").then((response) => response.json()));
  assert.equal(withInstructions.instructions.custom, "Summarize for a manager in three bullets.");
  const instructionsReset = page.waitForResponse((response) => response.url().endsWith("/api/conversation-summary/instructions") && response.request().method() === "PUT");
  await page.getByTestId("settings-summary-instructions-reset").click();
  assert.equal((await instructionsReset).status(), 200);
  await page.waitForFunction(() => document.querySelector("[data-testid='settings-summary-instructions-status']")?.textContent === "Saved · built-in instructions");
  assert.match(await instructionsBox.inputValue(), /^You keep a running summary of a conversation/);
  await page.keyboard.press("Escape");
  await page.locator("#settingsDialog[open]").waitFor({ state: "detached" });

  // Steps stay inspectable in the panel.
  await panel.locator(".tool-output .tool-name", { hasText: "Bash" }).first().click();
  await panel.getByText("production.pem").waitFor();

  // Collapsing hands the width back and is remembered.
  await page.getByTestId("activity-steps-toggle").click();
  await page.getByTestId("activity-list").waitFor({ state: "hidden" });
  await page.getByTestId("activity-panel-close").click();
  await panel.waitFor({ state: "hidden" });
  assert.equal(await page.getByTestId("chat-activity-toggle").getAttribute("aria-expanded"), "false");
  const widened = await page.locator("#messages").boundingBox();
  assert.ok(widened && messagesBox && widened.width > messagesBox.width + 200, "the thread takes the freed width");

  // The marker reopens the panel on its group, with the steps open.
  await marker.click();
  await panel.waitFor({ state: "visible" });
  await page.getByTestId("activity-list").waitFor();
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
  await page.evaluate(async () => {
    const { handleSocketPayload } = await import("/app/socket.js");
    handleSocketPayload({ type: "toolStart", toolName: "Skill", toolCallId: "live-0", toolTarget: { skill: "db-tools" } });
    handleSocketPayload({ type: "toolEnd", toolName: "Skill", toolCallId: "live-0", text: "Launching skill: db-tools" });
    handleSocketPayload({ type: "toolStart", toolName: "Bash", toolCallId: "live-1", toolTarget: { target: "npm run migrate" } });
  });
  assert.match(await working.innerText(), /Running Bash · npm run migrate/);
  await page.evaluate(async () => {
    const { handleSocketPayload } = await import("/app/socket.js");
    handleSocketPayload({ type: "toolEnd", toolName: "Bash", toolCallId: "live-1", text: "migrated" });
    handleSocketPayload({ type: "assistantFinal", text: "Migration 42 finished; checking row counts." });
  });
  assert.match(await working.innerText(), /Working…/);
  assert.equal(await lastInThread(), "live-activity", "new answers land above the working row");
  // The turn's skills move to its newest answer, and the statistics count the new ones.
  assert.equal(await skillsChip.count(), 1);
  assert.match(await skillsChip.innerText(), /skills\s*cert-tools, db-tools/);
  assert.equal(await skillsChip.evaluate((chip) => chip.closest(".message-actions")?.previousElementSibling?.textContent?.includes("Migration 42 finished")), true);
  await page.waitForFunction(() => document.querySelector("[data-testid='activity-stats-status']")?.textContent === "305 steps · 2 skills");
  await working.click();
  await page.waitForFunction(() => document.querySelector("#activityList .activity-group.highlighted"));
  await page.evaluate(async () => (await import("/app/socket.js")).handleSocketPayload({ type: "agent_end" }));
  await working.waitFor({ state: "detached" });

  // While auto respond decides what to answer, the thread says so and names what it checks,
  // and Stop can end it: the agent itself is idle, so nothing else would show the work.
  const abort = page.getByTestId("chat-abort-button");
  const autoRespond = (decision: { startedAt: string; step: string | null } | null) => page.evaluate(async (decision) => (await import("/app/socket.js")).handleSocketPayload({
    type: "autoRespond", state: { status: "active", responses: 1, maxResponses: 10, stopReason: null }, decision, message: "Auto respond is on",
  }), decision);
  await autoRespond({ startedAt: new Date(Date.now() - 65_000).toISOString(), step: null });
  await working.waitFor();
  assert.match(await working.innerText(), /Auto respond is checking the work\s+1m 0[5-9]s/);
  assert.equal(await abort.isEnabled(), true, "Stop ends the decision");
  await autoRespond({ startedAt: new Date(Date.now() - 65_000).toISOString(), step: "Bash" });
  assert.match(await working.innerText(), /Auto respond is checking the work · Bash/);
  assert.equal(await lastInThread(), "live-activity");
  await autoRespond(null);
  await working.waitFor({ state: "detached" });
  assert.equal(await abort.isEnabled(), false);

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
  // It covers the whole width, leaving no strip of thread beside it, and scrolls as one page:
  // two small scrolling boxes on a phone clipped the statistics under the steps header.
  if (await page.getByTestId("activity-steps-toggle").getAttribute("aria-expanded") !== "true") await page.getByTestId("activity-steps-toggle").click();
  await page.evaluate(async () => {
    const transcript = await import("/app/chat-transcript.js");
    for (let index = 0; index < 40; index += 1) {
      const bubble = transcript.appendToolMessage("Bash", `phone-${index}`, 0, Date.now(), { target: `step ${index}` });
      transcript.updateToolMessage(bubble, "ok", "Done", false, 10);
    }
  });
  await waitFrames();
  const [phonePanel, phoneThread] = await Promise.all([panel.boundingBox(), page.locator(".messages-wrap").boundingBox()]);
  assert.ok(phonePanel && phoneThread && Math.abs(phonePanel.x - phoneThread.x) <= 0.5 && Math.abs(phonePanel.width - phoneThread.width) <= 1, `the panel covers the thread's width (${JSON.stringify({ phonePanel, phoneThread })})`);
  const phoneLayout = await panel.evaluate((element) => {
    const [overview, list] = [element.querySelector("#activityOverview")!, element.querySelector("#activityList")!];
    const heading = element.querySelector("[data-testid='activity-steps-toggle']")!.getBoundingClientRect();
    return {
      panelScrolls: element.scrollHeight > element.clientHeight + 1,
      overviewClipped: overview.scrollHeight > overview.clientHeight + 1,
      listClipped: list.scrollHeight > list.clientHeight + 1,
      headingBelowOverview: heading.top >= overview.getBoundingClientRect().bottom - 0.5,
    };
  });
  assert.deepEqual(phoneLayout, { panelScrolls: true, overviewClipped: false, listClipped: false, headingBelowOverview: true });
  // The header and its close button stay in reach at the end of a long list.
  await panel.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await waitFrames();
  const close = await page.getByTestId("activity-panel-close").boundingBox();
  assert.ok(close && phonePanel && close.y >= phonePanel.y && close.y + close.height <= phonePanel.y + 60, `close stays at the top (${JSON.stringify(close)})`);

  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(failedResponses, []);
});

test("the instructions section shows both AGENTS.md files and creates and edits them in the file editor", async () => {
  // A page of its own: the first test leaves its page mid-conversation on a phone-sized window.
  const own = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
  const page = await own.newPage();
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(error.stack || error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
  });
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 20_000 });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: PROJECT_NAME }).first().click();
  await page.locator(".session-card", { hasText: CONVERSATION_TITLE }).first().click();
  // The section fills in once the conversation's node says it is ready.
  await page.getByTestId("activity-instructions-project").waitFor({ timeout: 20_000 });
  if (await page.getByTestId("chat-activity-toggle").getAttribute("aria-expanded") !== "true") await page.getByTestId("chat-activity-toggle").click();
  const section = page.getByTestId("activity-instructions");
  await section.waitFor({ state: "visible" });
  assert.equal(await section.evaluate((details: HTMLDetailsElement) => details.open), true);
  const global = page.getByTestId("activity-instructions-global");
  const project = page.getByTestId("activity-instructions-project");
  await project.waitFor();
  assert.match(await global.innerText(), /All projects\s+None yet\./);
  assert.match(await project.innerText(), /This project · AGENTS\.md\s+None yet\./);

  // Creating the project's file: the editor opens empty, and saving writes it into the project folder.
  const save = async (text: string) => {
    await page.getByTestId("file-action-dialog").waitFor({ state: "visible" });
    await page.locator("#fileEditorView .CodeMirror").first().waitFor();
    await page.evaluate((value) => (document.querySelector("#fileEditorView .CodeMirror") as HTMLElement & { CodeMirror: { setValue(value: string): void } }).CodeMirror.setValue(value), text);
    await page.getByTestId("file-editor-save-button").click();
    await page.getByTestId("file-action-dialog").waitFor({ state: "hidden" });
  };
  await page.getByTestId("activity-instructions-project-edit").click();
  await save("# Infra rules\n\nNever rotate production on a Friday.\n");
  const projectFile = path.join(projectNamed(node, PROJECT_NAME).path, "AGENTS.md");
  assert.equal(await readFile(projectFile, "utf8"), "# Infra rules\n\nNever rotate production on a Friday.\n");
  await page.waitForFunction(() => document.querySelector("[data-testid='activity-instructions-project'] .activity-instructions-preview")?.textContent?.includes("Never rotate"));
  assert.equal(await page.getByTestId("activity-instructions-project-edit").innerText(), "Edit");

  // The file every project shares, through its own endpoint.
  await page.getByTestId("activity-instructions-global-edit").click();
  await save("Answer in short sentences.\n");
  await page.waitForFunction(() => document.querySelector("[data-testid='activity-instructions-global'] .activity-instructions-preview")?.textContent === "Answer in short sentences.");
  const admin = await signIn(environment, node);
  assert.equal((await api<{ content: string }>(node, admin, "GET", "/instructions/global/content")).body.content, "Answer in short sentences.\n");

  // Viewing opens the same editor read-only.
  await page.getByTestId("activity-instructions-project-view").click();
  await page.getByTestId("file-action-dialog").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("file-editor-save-button").isVisible(), false);
  await page.keyboard.press("Escape");
  await rm(projectFile);
  await own.close();

  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(failedResponses, []);
});
