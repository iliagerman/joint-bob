// A real Chrome walks the journey the feature exists for: a ticket created on
// the board owns a conversation, and that conversation must be findable in the
// conversations list — marked as a ticket, with a button that jumps straight
// into the ticket. Source assertions cannot see a row that never rendered.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { projectNamed, seedDevEnvironment, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "../dev-nodes.js";

const TICKET_TITLE = "Fix the payment webhook";
const CONVERSATION_NAME = "Payment webhook fix transcript";

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let server: ChildProcess;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const consoleErrors: string[] = [];
const failedResponses: string[] = [];

/** Seeds one ticket whose conversation transcript exists, the state a finished
 *  or in-flight board run leaves behind. */
async function seedTicketConversation(): Promise<void> {
  const project = projectNamed(node, "Joint Bob");
  const taskId = "ticketwebhook1";
  const workspace = path.join(environment.home, "JointBob", "tickets", project.id, taskId);
  const sessionId = "ticket-webhook-conversation";
  const at = (minutes: number) => new Date(Date.parse("2026-08-30T10:00:00.000Z") + minutes * 60_000).toISOString();

  const records = [
    { type: "session", version: 3, id: sessionId, timestamp: at(0), cwd: workspace },
    { type: "session_info", name: CONVERSATION_NAME, timestamp: at(0) },
    { type: "message", id: `${sessionId}-0`, parentId: null, timestamp: at(1), message: { role: "user", content: [{ type: "text", text: "Fix the payment webhook" }], timestamp: Date.parse(at(1)) } },
    { type: "message", id: `${sessionId}-1`, parentId: `${sessionId}-0`, timestamp: at(2), message: { role: "assistant", content: [{ type: "text", text: "The retry budget was per-session." }], timestamp: Date.parse(at(2)) } },
  ];
  await mkdir(workspace, { recursive: true });
  const transcriptPath = path.join(environment.home, ".pi", "sessions", `${sessionId}.jsonl`);
  await writeFile(transcriptPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

  const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
  const nodeId = (db.prepare("SELECT id FROM cluster_node WHERE singleton = 1").get() as { id: string }).id;
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL,
    engine TEXT NOT NULL, plan_mode INTEGER NOT NULL, review_mode INTEGER NOT NULL, phase_config TEXT NOT NULL,
    session_path TEXT, worktree_path TEXT, worktree_branch TEXT, merged_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    current_node_id TEXT NOT NULL DEFAULT '', lease_owner_node_id TEXT, lease_expires_at TEXT, lease_token TEXT,
    execution_state TEXT NOT NULL DEFAULT 'idle', handoff_context TEXT, origin_node_id TEXT NOT NULL DEFAULT '', active_handoff_id TEXT
  ); CREATE INDEX IF NOT EXISTS tasks_project_id_updated_at ON tasks(project_id, updated_at DESC);`);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, status, engine, plan_mode, review_mode, phase_config, session_path, worktree_path, worktree_branch, merged_at, created_at, updated_at, current_node_id, lease_owner_node_id, lease_expires_at, execution_state, handoff_context, origin_node_id)
    VALUES (?, ?, ?, '', 'in_progress', 'pi', 0, 0, '{}', ?, ?, NULL, NULL, ?, ?, ?, NULL, NULL, 'idle', NULL, ?)`)
    .run(taskId, project.id, TICKET_TITLE, transcriptPath, workspace, at(0), at(0), nodeId, nodeId);
  db.close();
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-ticket-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  await seedTicketConversation();
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

async function openJointBobProject(): Promise<void> {
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 20_000 });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  // Wait for the project row itself: the boot splash carries the same wordmark and
  // stays hidden, so a bare text match waits on an element that never appears.
  const projectCard = page.locator(".project-card", { hasText: "Joint Bob" }).first();
  await projectCard.waitFor({ timeout: 20_000 });
  await projectCard.click();
  await page.locator(".session-card").first().waitFor({ timeout: 20_000 });
}

test("the board ticket chat button opens that ticket's conversation", async () => {
  await openJointBobProject();
  await page.locator(".session-card", { hasText: "Canvas picker readability" }).click();
  await page.locator(".message", { hasText: "grid tracks shrink" }).waitFor({ timeout: 20_000 });

  await page.getByTestId("chats-open-board-button").click();
  const ticketCard = page.getByTestId("board-task-card").filter({ hasText: TICKET_TITLE });
  await ticketCard.getByTestId("board-task-open-chat-button").click();
  await page.locator(".message", { hasText: "retry budget was per-session" }).waitFor({ timeout: 20_000 });
});

test("a ticket conversation is listed, marked, and jumps into its ticket", async () => {
  // The precondition the whole test hangs on: the ticket's conversation reached the list.
  const ticketRow = page.locator(".list-row", { hasText: CONVERSATION_NAME }).first();
  await ticketRow.waitFor({ timeout: 20_000 });

  // The mark: a Ticket badge on this row, and on no other row.
  await page.getByTestId("session-ticket-badge").waitFor({ timeout: 10_000 });
  const badgeText = (await page.getByTestId("session-ticket-badge").innerText()).trim();
  assert.equal(badgeText, "Ticket", `the badge names what the row belongs to (got ${JSON.stringify(badgeText)})`);
  const markedRows = await page.locator(".list-row", { has: page.getByTestId("session-ticket-badge") }).count();
  assert.equal(markedRows, 1, "only the ticket conversation carries the badge");

  // The quick button lives on the same row and nowhere else.
  await page.getByTestId("session-ticket-button").waitFor({ timeout: 10_000 });
  const buttonRows = await page.locator(".list-row", { has: page.getByTestId("session-ticket-button") }).count();
  assert.equal(buttonRows, 1, "only the ticket conversation carries the ticket button");

  // First open another conversation. Its id must not override the path from the
  // ticket button when the ticket conversation opens next.
  await page.locator(".session-card", { hasText: "Canvas picker readability" }).click();
  await page.locator(".message", { hasText: "grid tracks shrink" }).waitFor({ timeout: 20_000 });

  // The button navigates directly into the ticket, not into the conversation.
  await page.getByTestId("session-ticket-button").click();
  await page.locator("#taskDialog[open]").waitFor({ timeout: 20_000 });
  assert.equal(await page.locator("#taskTitleInput").inputValue(), TICKET_TITLE, "the ticket dialog shows the ticket, not the chat");
  // A ticket with a conversation opens on its conversation tab and loads that
  // ticket's transcript rather than the previously opened conversation.
  await page.locator('#taskChatHost:not([hidden])').waitFor({ timeout: 10_000 });
  await page.locator("#taskChatHost .message", { hasText: "retry budget was per-session" }).waitFor({ timeout: 20_000 });

  await page.keyboard.press("Escape");
  await page.locator("#taskDialog[open]").waitFor({ state: "detached", timeout: 10_000 });
});

test("the ticket jump button keeps its lane when the row is also pinned", async () => {
  // Pin with the row's own quick action, the way a person pins a conversation.
  const row = page.locator(".list-row", { hasText: CONVERSATION_NAME }).first();
  await row.getByTestId("session-pin-button").click();
  await page.locator(".list-row.pinned.has-ticket").first().waitFor({ timeout: 10_000 });

  const lanes = await page.evaluate(() => {
    const row = document.querySelector(".list-row.pinned.has-ticket");
    if (!row) throw new Error("pinned ticket row missing");
    // No helpers: the test runner's transform breaks functions declared inside evaluate.
    const menu = row.querySelector('[data-testid="session-menu-button"]')!.getBoundingClientRect();
    const ticket = row.querySelector('[data-testid="session-ticket-button"]')!.getBoundingClientRect();
    const unpin = row.querySelector(".pin-button")!.getBoundingClientRect();
    const title = row.querySelector(".session-card strong")!.getBoundingClientRect();
    return {
      menu: { left: menu.left, right: menu.right },
      ticket: { left: ticket.left, right: ticket.right },
      unpin: { left: unpin.left, right: unpin.right },
      titleRight: title.right,
    };
  });

  // Three separate lanes, left to right: unpin, ticket, menu — none overlapping.
  assert.ok(lanes.ticket.right < lanes.menu.left - 2,
    `the ticket button clears the menu button (ticket ends ${lanes.ticket.right}, menu starts ${lanes.menu.left})`);
  assert.ok(lanes.unpin.right < lanes.ticket.left - 2,
    `the unpin button clears the ticket button (unpin ends ${lanes.unpin.right}, ticket starts ${lanes.ticket.left})`);
  // The row pays for the lanes with padding, so the title stops before the first one.
  assert.ok(lanes.titleRight <= lanes.unpin.left + 1,
    `the title stops before the button lanes (title ends ${lanes.titleRight}, unpin starts ${lanes.unpin.left})`);
});

test("the journey produced no console errors and no failed requests", () => {
  assert.deepEqual(consoleErrors, [], "no console errors");
  assert.deepEqual(failedResponses, [], "no 4xx or 5xx responses");
});
