// A real Chrome walks the worktree journey: create a worktree from the conversation
// list, see a conversation that ran inside it listed in the worktree's sub-section,
// fold it, start a new conversation there without the start prompt, merge it back,
// and delete it everywhere.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { type Browser, type BrowserContext, type Page } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { projectNamed, seedDevEnvironment, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "../dev-nodes.js";

const WORKTREE_NAME = "audit-suppressed-ticket-confirmation-loop-20261008";
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
  const section = page.getByTestId("worktree-section").filter({ hasText: WORKTREE_NAME });
  await section.waitFor({ timeout: 20_000 });
  await page.locator("#worktreeDialog[open]").waitFor({ state: "detached", timeout: 10_000 });

  const worktree = await onlyWorktreePath();
  assert.equal(await readFile(path.join(worktree, "src", "inbox.ts"), "utf8"), "export const inbox = 'mock';\n");
  assert.ok((await lstat(path.join(worktree, "node_modules"))).isSymbolicLink(), "dependencies are linked, not copied");
  assert.equal(await realpath(path.join(worktree, "node_modules")), await realpath(path.join(project.path, "node_modules")));
  assert.equal(await section.getAttribute("data-worktree-color"), "teal", "the first worktree gets a vivid colour, not slate");
  assert.equal((await section.getByTestId("worktree-section-count").innerText()).trim(), "0");
});

test("a conversation that ran in the worktree is listed in the worktree's sub-section, which folds", async () => {
  const worktree = await onlyWorktreePath();
  await seedWorktreeConversation(worktree);
  await page.reload({ waitUntil: "domcontentloaded" });
  await openProject();

  const row = page.locator(".list-row", { hasText: CONVERSATION_NAME }).first();
  await row.waitFor({ timeout: 20_000 });
  assert.match(await row.getAttribute("class") ?? "", /\bhas-worktree\b/);
  const badge = row.getByTestId("session-worktree-badge");
  assert.equal((await badge.innerText()).trim(), WORKTREE_NAME);
  const section = page.getByTestId("worktree-section").first();
  const color = await section.getAttribute("data-worktree-color");
  assert.equal(await row.locator(".session-card").getAttribute("data-worktree-color"), color);
  const stripe = await row.locator(".session-card").evaluate((card) => getComputedStyle(card).boxShadow);
  assert.match(stripe, /inset/, `the worktree hue is drawn on the card (${stripe})`);
  assert.equal(await page.locator("#sessionList .list-row", { has: page.getByTestId("session-worktree-badge") }).count(), 1, "only the worktree conversation is marked");
  assert.equal((await section.getByTestId("worktree-section-count").innerText()).trim(), "1");

  const layout = await page.evaluate(() => [...document.querySelectorAll("#sessionList > *")].map((element) => (element as HTMLElement).dataset.testid || (element.classList.contains("has-worktree") ? "worktree-row" : "project-row")));
  assert.deepEqual(layout.slice(0, 4), ["worktree-subsection", "worktree-section", "worktree-row", "project-folder-subsection"], layout.join(", "));
  assert.ok(layout.slice(4).length > 0 && layout.slice(4).every((entry) => entry === "project-row"), "the project folder's conversations follow the worktrees");

  const total = await page.locator("#sessionList .list-row").count();
  await page.getByTestId("worktree-section-toggle").first().click();
  await page.waitForFunction((expected) => document.querySelectorAll("#sessionList .list-row").length === expected - 1, total);
  assert.equal(await page.locator("#sessionList .list-row", { hasText: CONVERSATION_NAME }).count(), 0, "a folded worktree hides its conversations");
  assert.equal(await page.getByTestId("worktree-section-toggle").first().getAttribute("aria-expanded"), "false");
  await page.getByTestId("worktree-section-toggle").first().click();
  await page.waitForFunction((expected) => document.querySelectorAll("#sessionList .list-row").length === expected, total);
});

test("worktree grouping does not wait for a slow cleanup scan", async () => {
  let release!: () => void;
  const scan = new Promise<void>((resolve) => { release = resolve; });
  const route = "**/api/projects/*/worktrees/cleanup";
  let cleanupRequests = 0;
  let listRequests = 0;
  await page.route("**/api/projects/*/worktrees", async (request) => { listRequests += 1; await request.continue(); });
  await page.route(route, async (request) => {
    cleanupRequests += 1;
    await scan;
    await request.continue();
  });
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await openProject();
    const row = page.locator("#sessionList .list-row", { hasText: CONVERSATION_NAME });
    await row.getByTestId("session-worktree-badge").waitFor();
    const section = page.getByTestId("worktree-section").filter({ hasText: WORKTREE_NAME });
    await section.waitFor({ timeout: 5_000 });
    assert.equal(await section.getByTestId("worktree-section-count").innerText(), "1");
    assert.ok(listRequests > 0, "headers come from the fast listing endpoint");
    await page.evaluate(async () => {
      const { loadWorktrees } = await import("/app/worktrees.js");
      await loadWorktrees();
      await loadWorktrees();
    });
    assert.equal(cleanupRequests, 1, "refresh notices do not pile up cleanup requests");
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("conversation badges still have matching groups while the worktree listing is pending", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/projects/*/worktrees", async (request) => { await pending; await request.continue(); });
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await openProject();
    const row = page.locator("#sessionList .list-row", { hasText: CONVERSATION_NAME });
    await row.getByTestId("session-worktree-badge").waitFor();
    const header = page.getByTestId("worktree-section").filter({ hasText: WORKTREE_NAME });
    await header.waitFor({ timeout: 5_000 });
    const order = await page.evaluate(() => [...document.querySelectorAll("#sessionList > *")].map((element) => (element as HTMLElement).dataset.testid || (element.classList.contains("has-worktree") ? "worktree-row" : "project-row")));
    assert.deepEqual(order.slice(0, 4), ["worktree-subsection", "worktree-section", "worktree-row", "project-folder-subsection"]);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("a late worktree listing keeps empty groups collapsed without moving visible conversations", async () => {
  const empty = await page.evaluate(async () => {
    const { api } = await import("/app/api.js");
    const { state } = await import("/app/state.js");
    return (await api(`/api/projects/${state.activeProjectId}/worktrees`, { method: "POST", body: JSON.stringify({ name: "Empty worktree", color: "amber" }) })).worktree;
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/projects/*/worktrees", async (request) => { await pending; await request.continue(); });
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await openProject();
    const row = page.locator("#sessionList .list-row", { hasText: CONVERSATION_NAME });
    await row.waitFor();
    assert.equal(await page.getByTestId("worktree-section").count(), 1, "initial groups come from conversations");
    release();
    await page.waitForFunction(async (id) => (await import("/app/state.js")).state.worktrees.some((worktree) => worktree.id === id), empty.id);
    assert.equal(await page.locator("#sessionList > [data-testid='worktree-section']").count(), 1, "the late listing must not insert an empty top-level group");
    const section = page.getByTestId("worktree-section").filter({ hasText: "Empty worktree" });
    assert.equal(await section.isVisible(), false);
    const toggle = page.getByTestId("other-worktrees-toggle");
    assert.equal(await toggle.innerText(), "Other worktrees (1)");
    await toggle.click();
    await section.waitFor();
    await page.evaluate(async () => {
      await (await import("/app/worktrees.js")).loadWorktrees();
      (await import("/app/session-list.js")).renderSessions();
    });
    assert.equal(await section.isVisible(), true, "refresh preserves an explicitly expanded section");
    await section.getByTestId("worktree-menu-button").click();
    await page.getByTestId("worktree-menu-new-conversation").waitFor();
    await page.keyboard.press("Escape");
    await toggle.click();
    assert.equal(await section.isVisible(), false);
    assert.equal(await row.isVisible(), true, "occupied groups stay visible");
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
    await page.evaluate(async (id) => {
      const { api } = await import("/app/api.js");
      const { state } = await import("/app/state.js");
      await api(`/api/projects/${state.activeProjectId}/worktrees/${id}`, { method: "DELETE" });
      await (await import("/app/worktrees.js")).loadWorktrees();
    }, empty.id);
  }
});

test("long worktree headers and conversation cards fit the column without horizontal scrolling", async () => {
  try {
    for (const width of [1440, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const geometry = await page.evaluate(() => {
        const list = document.querySelector<HTMLElement>("#sessionList")!;
        const bounds = list.getBoundingClientRect();
        const name = list.querySelector<HTMLElement>(".worktree-section-name")!;
        const items = [...list.querySelectorAll(".worktree-section-header, .session-card, .worktree-section-count, .worktree-section-menu, .row-action-button")];
        return {
          width: list.clientWidth,
          scrollWidth: list.scrollWidth,
          nameWidth: name.clientWidth,
          nameScrollWidth: name.scrollWidth,
          overflowing: items.filter((item) => {
            const box = item.getBoundingClientRect();
            return box.left < bounds.left || box.right > bounds.left + list.clientWidth;
          }).map((item) => item.className),
        };
      });
      assert.ok(geometry.nameScrollWidth > 250, "fixture name must be wider than a narrow column");
      assert.ok(geometry.scrollWidth <= geometry.width, `at ${width}px, list must fit: ${JSON.stringify(geometry)}`);
      assert.deepEqual(geometry.overflowing, [], `at ${width}px, cards and actions must stay inside the column`);
      assert.ok(geometry.nameWidth > 0 && geometry.nameWidth < geometry.nameScrollWidth, `at ${width}px, only the long name should truncate`);
      await page.getByTestId("worktree-menu-button").first().click();
      await page.getByTestId("worktree-menu-new-conversation").waitFor();
      await page.keyboard.press("Escape");
    }
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
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

test("a conversation started in the worktree skips the start-of-conversation prompt", async () => {
  const START_PROMPT = "Update from main first.";
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-commands").click();
  await page.getByTestId("settings-start-conversation-enabled").check();
  await page.getByTestId("settings-start-conversation-prompt").fill(START_PROMPT);
  await page.getByTestId("settings-save-button").click();
  await page.locator("#settingsDialog[open]").waitFor({ state: "hidden", timeout: 20_000 });
  await page.getByTestId("worktree-menu-button").first().click();
  await page.getByTestId("worktree-menu-new-conversation").click();
  await page.locator("#choiceDialog[open]").waitFor({ timeout: 10_000 });
  await page.getByTestId("choice-accept-button").click();
  await page.locator("#newSessionNameDialog[open]").waitFor({ timeout: 10_000 });
  await page.getByTestId("new-session-name-input").fill("Worktree start check");
  await page.getByTestId("new-session-name-start-button").click();
  const state = await page.evaluateHandle(async () => (await import("/app/state.js")).state);
  await page.waitForFunction((state) => Boolean(state.activeSessionId), state, { timeout: 30_000 });
  await state.dispose();
  const row = page.locator("#sessionList .list-row.active");
  await row.waitFor({ timeout: 20_000 });
  assert.match(await row.getAttribute("class") ?? "", /\bhas-worktree\b/, "the new conversation runs in the worktree");
  // The prompt would be queued as soon as the conversation is ready; give it time to show.
  await page.waitForTimeout(3_000);
  assert.equal(await page.getByText(START_PROMPT, { exact: true }).count(), 0, "the start prompt is not sent in a worktree");
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
  await page.getByTestId("worktree-section").waitFor({ state: "detached", timeout: 20_000 });
  assert.equal(await exists(worktree), false);
  assert.equal(consoleErrors.filter((message) => !/favicon|ERR_ABORTED|WebSocket/i.test(message)).length, 0, consoleErrors.join("\n"));
});

test("with the setting on, each new conversation starts in a worktree of its own named after it", async () => {
  const AUTO_NAME = "Inbox persistence";
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-conversations").click();
  await page.getByTestId("settings-new-conversation-worktree").check();
  await page.getByTestId("settings-save-button").click();
  await page.locator("#settingsDialog[open]").waitFor({ state: "hidden", timeout: 20_000 });

  await page.getByTestId("session-create-button").click();
  await page.locator("#newSessionNameDialog[open]").waitFor({ timeout: 10_000 });
  await page.getByTestId("new-session-name-input").fill(AUTO_NAME);
  const picked = await page.getByTestId("new-session-worktree-select").evaluate((element) => (element as HTMLSelectElement).value);
  assert.equal(picked, "new", "New worktree is the default choice");
  await page.getByTestId("new-session-name-start-button").click();

  const section = page.getByTestId("worktree-section").filter({ hasText: AUTO_NAME });
  await section.waitFor({ timeout: 60_000 });
  const row = page.locator("#sessionList .list-row.active");
  await row.waitFor({ timeout: 20_000 });
  assert.match(await row.getAttribute("class") ?? "", /\bhas-worktree\b/, "the conversation runs in the new worktree");
  assert.equal((await row.getByTestId("session-worktree-badge").innerText()).trim(), AUTO_NAME);
  const worktree = await onlyWorktreePath();
  assert.equal(await readFile(path.join(worktree, "src", "inbox.ts"), "utf8"), "export const inbox = 'real';\n", "the worktree copies the project as it is now");
});

test("marking the last conversation done removes its worktree header and folder", async () => {
  const worktree = await onlyWorktreePath();
  const row = page.locator("#sessionList .list-row.active");
  await row.getByTestId("session-menu-button").click();
  const marked = page.waitForResponse((response) => response.url().endsWith("/sessions/done") && response.request().method() === "PUT");
  await page.getByTestId("session-done-button").click();
  const result = await (await marked).json();
  assert.deepEqual(result.deletedWorktreeIds, [path.basename(worktree)], JSON.stringify(result));
  await page.getByTestId("worktree-section").waitFor({ state: "detached", timeout: 20_000 });
  assert.equal(await exists(worktree), false, "the folder is deleted, not merely hidden");
  await page.reload({ waitUntil: "domcontentloaded" });
  await openProject();
  assert.equal(await page.getByTestId("worktree-section").count(), 0, "no zero-count header returns after reload");
});
