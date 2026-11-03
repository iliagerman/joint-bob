// A conversation can open read-only for more than one reason. The notice said "Done ticket" for
// all of them, so a teammate whose machine was refused by the machine running the conversation,
// or anyone reading a sub-agent's transcript, was told it was a finished ticket. The node now
// sends the reason with `ready` (see test/cluster-teammate-runs.test.ts); this checks the page
// says it in plain words and does not offer what the reader cannot do.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright-core";
import { claudeProjectDir } from "../../src/session-paths.js";
import { projectNamed } from "../dev-nodes.js";
import { nativeUiFixture } from "./native-ui-fixture.js";

const PROJECT_NAME = "Internal Assistant";
const REFUSED_TITLE = "Makor deployment information";
const OTHER_TITLE = "Pending follow request review";
const ROW_ON_REFUSING_MACHINE = "Short one";
const ROW_HERE = "Flow Runner Tool Evaluation";
const REFUSING_MACHINE = { id: "00000000-0000-4000-8000-0000000c0ffe", name: "Home server", local: false, online: true, mapped: true, terminal: false, runner: false };
const WRITE_ACTIONS = ["session-fork-button", "session-rename-button", "session-remove-button", "session-classification-button", "session-secrets-button", "session-cron-button"];

async function signInAndOpenProject(page: Page, url: string, username: string, password: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor();
  await page.getByTestId("login-username-input").fill(username);
  await page.getByTestId("login-password-input").fill(password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: PROJECT_NAME }).first().click();
}

/** The overflow menu of the row titled `title`: which of the write actions it offers. */
async function offeredWriteActions(page: Page, title: string): Promise<string[]> {
  const row = page.locator("#sessionList .list-row").filter({ has: page.locator("strong", { hasText: title }) }).first();
  await row.getByTestId("session-menu-button").click();
  await page.getByTestId("session-add-to-canvas-button").waitFor();
  const offered: string[] = [];
  for (const testid of WRITE_ACTIONS) if (await page.locator("#rowMenu").getByTestId(testid).count()) offered.push(testid);
  await page.keyboard.press("Escape");
  await page.locator("#rowMenu").waitFor({ state: "hidden" });
  return offered;
}

test("a conversation whose machine refuses this one says so, where to change it, and offers no write actions", { timeout: 180_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  // The conversation socket answers the way a node that does not accept runs from this one does.
  let refusing = true;
  await page.routeWebSocket(/\/ws\?/, (socket) => {
    const server = socket.connectToServer();
    if (socket.url().includes("sessionPath=watch")) return;
    const rewrite = refusing;
    server.onMessage((message) => {
      if (rewrite && typeof message === "string" && message.includes('"type":"ready"')) {
        socket.send(JSON.stringify({ ...JSON.parse(message), readOnly: true, readOnlyReason: "runnerAccess", executionNodeName: "Home server" }));
        return;
      }
      socket.send(message);
    });
  });
  // One more machine in Runs on, which does not accept runs from this one, and one row that runs there.
  await page.route("**/api/projects/*/session-nodes", async (route) => {
    const response = await route.fetch().catch(() => null);
    if (!response) return;
    const body = await response.json() as { nodes: unknown[] };
    await route.fulfill({ response, json: { ...body, nodes: [...body.nodes, REFUSING_MACHINE] } }).catch(() => undefined);
  });
  await page.route("**/api/projects/*/sessions", async (route) => {
    const response = await route.fetch().catch(() => null);
    if (!response) return;
    const body = await response.json() as { sessions: Array<{ title: string; executionNodeId?: string }> };
    const sessions = body.sessions.map((session) => session.title.includes(ROW_ON_REFUSING_MACHINE) ? { ...session, executionNodeId: REFUSING_MACHINE.id } : session);
    await route.fulfill({ response, json: { ...body, sessions } }).catch(() => undefined);
  });
  await signInAndOpenProject(page, node.url, environment.username, environment.password);
  await page.locator(".session-card", { hasText: REFUSED_TITLE }).first().click();

  const notice = page.getByTestId("done-conversation-notice");
  await notice.waitFor({ state: "visible" });
  const text = await notice.innerText();
  assert.doesNotMatch(text, /Done ticket/, "a refused runner is not a Done ticket");
  assert.match(text, /Read-only here/);
  assert.match(text, /Home server does not let other machines run work on it/);
  assert.match(text, /Settings → Node on Home server/, "the notice says where the setting is");
  assert.equal(await page.getByTestId("done-conversation-continue-button").isHidden(), true, "the Done ticket follow-up does not apply");
  assert.equal(await page.locator("#composer").isHidden(), true, "nothing can be sent from here");
  assert.deepEqual(await offeredWriteActions(page, REFUSED_TITLE), [], "the open conversation's menu offers nothing its machine would refuse");

  // A row that runs on the refusing machine, known from Runs on without opening it, and one that runs here.
  await page.waitForFunction(async (id) => (await import("/app/state.js")).state.sessionNodes.some((candidate: { id: string }) => candidate.id === id), REFUSING_MACHINE.id);
  assert.deepEqual(await offeredWriteActions(page, ROW_ON_REFUSING_MACHINE), [], "a row on a refusing machine offers no write actions");
  assert.deepEqual(await offeredWriteActions(page, ROW_HERE), WRITE_ACTIONS, "a row this machine runs keeps every action");

  // The next conversation, which this node may write in, leaves the notice behind.
  refusing = false;
  await page.locator(".session-card", { hasText: OTHER_TITLE }).first().click();
  await page.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>("#messageInput")!.disabled);
  assert.equal(await notice.isHidden(), true);
});

test("a sub-agent conversation says it can't be continued, not that it is a Done ticket", { timeout: 180_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  // A Claude conversation that started a sub-agent, as Claude Code lays them out on disk.
  const project = projectNamed(node, PROJECT_NAME);
  const parentId = randomUUID();
  const directory = claudeProjectDir(project.path, path.join(environment.home, ".claude", "projects"));
  await mkdir(path.join(directory, parentId, "subagents"), { recursive: true });
  for (const [file, text] of [[path.join(directory, `${parentId}.jsonl`), "Check the deployment notes"], [path.join(directory, parentId, "subagents", "agent-reader.jsonl"), "Read the deployment notes"]]) {
    await writeFile(file, JSON.stringify({ type: "user", uuid: randomUUID(), sessionId: parentId, cwd: project.path, timestamp: new Date().toISOString(), message: { role: "user", content: text } }) + "\n");
  }
  await signInAndOpenProject(page, node.url, environment.username, environment.password);
  // The child is nested under its parent in the list; open it the way the board and the canvas do.
  await page.waitForFunction(async () => (await import("/app/state.js")).state.sessions.some((session: { readOnly?: boolean }) => session.readOnly === true));
  await page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    const { openSession } = await import("/app/socket.js");
    const child = state.sessions.find((session: { readOnly?: boolean }) => session.readOnly === true);
    openSession(child.path, child.title);
  });

  const notice = page.getByTestId("done-conversation-notice");
  await notice.waitFor({ state: "visible" });
  const text = await notice.innerText();
  assert.doesNotMatch(text, /Done ticket/, "a sub-agent's transcript is not a Done ticket");
  assert.match(text, /Sub-agent conversation/);
  assert.match(text, /can't be continued/);
  assert.match(text, /conversation that started it/, "the notice says where to write instead");
  assert.equal(await page.getByTestId("done-conversation-continue-button").isHidden(), true, "the Done ticket follow-up does not apply");
  assert.equal(await page.locator("#composer").isHidden(), true);
});
