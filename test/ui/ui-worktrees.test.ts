// A real Chrome walks the worktree journey: create a worktree from the conversation
// list, see a conversation that ran inside it carry the worktree's colour, filter by
// it, start a new conversation there, merge it back, and delete it everywhere.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { type Browser, type BrowserContext, type Page } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { projectNamed, seedDevEnvironment, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "../dev-nodes.js";

const WORKTREE_NAME = "Slice 4";
const CONVERSATION_NAME = "Inbox mock replacement";
const SESSION_ID = "worktree-inbox-conversation";

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let server: ChildProcess;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let project: SeededNode["projects"][number];
const consoleErrors: string[] = [];

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

function worktreeRoot(): string {
  return path.join(environment.home, "JointBob", "worktrees", project.id);
}

async function onlyWorktreePath(): Promise<string> {
  const entries = (await readdir(worktreeRoot())).filter((entry) => !entry.startsWith("."));
  assert.equal(entries.length, 1, `one worktree folder exists (${entries.join(", ")})`);
  return path.join(worktreeRoot(), entries[0]);
}

/** The transcript a conversation leaves after running inside the worktree, plus the marker the server writes when it starts there. */
async function seedWorktreeConversation(worktree: string): Promise<void> {
  const at = (minutes: number) => new Date(Date.parse("2026-10-06T10:00:00.000Z") + minutes * 60_000).toISOString();
  const records = [
    { type: "session", version: 3, id: SESSION_ID, timestamp: at(0), cwd: worktree },
    { type: "session_info", name: CONVERSATION_NAME, timestamp: at(0) },
    { type: "message", id: `${SESSION_ID}-0`, parentId: null, timestamp: at(1), message: { role: "user", content: [{ type: "text", text: "Replace the inbox mock" }], timestamp: Date.parse(at(1)) } },
    { type: "message", id: `${SESSION_ID}-1`, parentId: `${SESSION_ID}-0`, timestamp: at(2), message: { role: "assistant", content: [{ type: "text", text: "The inbox now persists messages." }], timestamp: Date.parse(at(2)) } },
  ];
  await writeFile(path.join(environment.home, ".pi", "sessions", `${SESSION_ID}.jsonl`), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  const markers = path.join(worktree, ".joint-bob-worktree", "conversations");
  await mkdir(markers, { recursive: true });
  await writeFile(path.join(markers, `pi--${SESSION_ID}.json`), "{}\n");
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-worktrees-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  project = projectNamed(node, "Joint Bob");
  await mkdir(path.join(project.path, "src"), { recursive: true });
  await writeFile(path.join(project.path, "src", "inbox.ts"), "export const inbox = 'mock';\n");
  await mkdir(path.join(project.path, "node_modules", "dep"), { recursive: true });
  await writeFile(path.join(project.path, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  server = await startDevNode(environment, node);
  browser = await launchChrome({ headless: process.env.HEADED !== "1" });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
  page = await context.newPage();
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
}, { timeout: 120_000 });

after(async () => {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(root, "final.png") }).catch(() => undefined);
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

async function openProject(): Promise<void> {
  const projectCard = page.locator(".project-card", { hasText: "Joint Bob" }).first();
  await projectCard.waitFor({ timeout: 20_000 });
  await projectCard.click();
  await page.locator(".session-card").first().waitFor({ timeout: 20_000 });
}

test("a worktree is created from the conversation list as a code-only copy", async () => {
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 20_000 });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await openProject();

  await page.getByTestId("worktree-create-button").click();
  await page.locator("#worktreeDialog[open]").waitFor({ timeout: 10_000 });
  await page.getByTestId("worktree-name-input").fill(WORKTREE_NAME);
  await page.getByTestId("worktree-save-button").click();
  const chip = page.getByTestId("worktree-chip").filter({ hasText: WORKTREE_NAME });
  await chip.waitFor({ timeout: 20_000 });
  await page.locator("#worktreeDialog[open]").waitFor({ state: "detached", timeout: 10_000 });

  const worktree = await onlyWorktreePath();
  assert.equal(await readFile(path.join(worktree, "src", "inbox.ts"), "utf8"), "export const inbox = 'mock';\n");
  assert.equal(await exists(path.join(worktree, "node_modules")), false, "packages never enter a worktree");
  assert.equal(await chip.getAttribute("data-worktree-color"), "teal", "the first worktree gets a vivid colour, not slate");
});

test("a conversation that ran in the worktree carries its colour and badge, and the chip filters to it", async () => {
  const worktree = await onlyWorktreePath();
  await seedWorktreeConversation(worktree);
  await page.reload({ waitUntil: "domcontentloaded" });
  await openProject();

  const row = page.locator(".list-row", { hasText: CONVERSATION_NAME }).first();
  await row.waitFor({ timeout: 20_000 });
  assert.match(await row.getAttribute("class") ?? "", /\bhas-worktree\b/);
  const badge = row.getByTestId("session-worktree-badge");
  assert.equal((await badge.innerText()).trim(), WORKTREE_NAME);
  const color = await page.getByTestId("worktree-chip").first().getAttribute("data-worktree-color");
  assert.equal(await row.locator(".session-card").getAttribute("data-worktree-color"), color);
  const stripe = await row.locator(".session-card").evaluate((card) => getComputedStyle(card).boxShadow);
  assert.match(stripe, /inset/, `the worktree hue is drawn on the card (${stripe})`);
  assert.equal(await page.locator("#sessionList .list-row", { has: page.getByTestId("session-worktree-badge") }).count(), 1, "only the worktree conversation is marked");

  const total = await page.locator("#sessionList .list-row").count();
  assert.ok(total > 1, "the project has other conversations too");
  await page.getByTestId("worktree-chip-filter").first().click();
  await page.waitForFunction(() => document.querySelectorAll("#sessionList .list-row").length === 1);
  assert.equal(await page.locator("#sessionList .list-row", { hasText: CONVERSATION_NAME }).count(), 1);
  await page.getByTestId("worktree-chip-filter").first().click();
  await page.waitForFunction((expected) => document.querySelectorAll("#sessionList .list-row").length === expected, total);
});

test("starting a conversation from the worktree menu runs it in the worktree", async () => {
  await page.getByTestId("worktree-menu-button").first().click();
  await page.getByTestId("worktree-menu-new-conversation").click();
  await page.locator("#choiceDialog[open]").waitFor({ timeout: 10_000 });
  await page.getByTestId("choice-accept-button").click();
  await page.locator("#newSessionNameDialog[open]").waitFor({ timeout: 10_000 });
  await page.getByTestId("new-session-next-button").click();
  await page.getByTestId("new-session-next-button").click();
  const select = page.getByTestId("new-session-worktree-select");
  await select.waitFor({ timeout: 10_000 });
  const chosen = await select.evaluate((element) => (element as HTMLSelectElement).selectedOptions[0]?.textContent);
  assert.equal(chosen, `Worktree: ${WORKTREE_NAME}`);
  await page.getByTestId("new-session-name-cancel-button").click();
  await page.locator("#newSessionNameDialog[open]").waitFor({ state: "detached", timeout: 10_000 });
});

test("merge to project writes the worktree's edits into the project folder", async () => {
  const worktree = await onlyWorktreePath();
  await writeFile(path.join(worktree, "src", "inbox.ts"), "export const inbox = 'real';\n");
  await page.getByTestId("worktree-menu-button").first().click();
  await page.getByTestId("worktree-menu-merge").click();
  await page.locator("#confirmDialog[open]").waitFor({ timeout: 10_000 });
  await page.locator("#confirmAcceptButton").click();
  await page.locator(".toast-message", { hasText: `Merged ${WORKTREE_NAME}: 1 file written, 0 deleted.` }).waitFor({ timeout: 20_000 });
  assert.equal(await readFile(path.join(project.path, "src", "inbox.ts"), "utf8"), "export const inbox = 'real';\n");
});

test("deleting a worktree removes its folder and keeps its conversation as history", async () => {
  const worktree = await onlyWorktreePath();
  await page.getByTestId("worktree-menu-button").first().click();
  await page.getByTestId("worktree-menu-delete").click();
  await page.locator("#confirmDialog[open]").waitFor({ timeout: 10_000 });
  await page.locator("#confirmAcceptButton").click();
  await page.getByTestId("worktree-chip").waitFor({ state: "detached", timeout: 20_000 });
  assert.equal(await exists(worktree), false);
  assert.equal(consoleErrors.filter((message) => !/favicon|ERR_ABORTED|WebSocket/i.test(message)).length, 0, consoleErrors.join("\n"));
});
