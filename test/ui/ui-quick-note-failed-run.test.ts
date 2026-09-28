import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { type Browser } from "playwright-core";
import { api, projectNamed, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";
import { launchChrome } from "./launch-chrome.js";

test("failed runs stay out of pending notes and open their original conversation without resending", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-failed-note-"));
  let server: ChildProcess | undefined;
  let browser: Browser | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const log = path.join(root, "engine.log");
    server = await startDevNode(environment, node, { JOINT_BOB_TEST_ENGINE_LOG: log });
    const auth = await signIn(environment, node);
    const project = projectNamed(node, "Internal Assistant");
    const input = { projectId: project.id, title: "Failed after output", content: "Inspect this original conversation", harnessId: "pi" };
    const created = await api<{ note: { id: string } }>(node, auth, "POST", "/quick-notes", input);
    assert.equal(created.status, 201);
    const id = created.body.note.id;
    const launched = await api<{ sessionId: string }>(node, auth, "POST", `/quick-notes/${id}/start`);
    assert.equal(launched.status, 200);
    const deadline = Date.now() + 30_000;
    while (true) {
      const result = await api<{ note: { status: string } }>(node, auth, "GET", `/quick-notes/${id}`);
      if (result.body.note.status === "completed") break;
      assert.ok(Date.now() < deadline, "fixture conversation must settle before changing its recorded outcome");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    // A real saved conversation, with the failure the screenshot shows recorded on its note.
    const database = new DatabaseSync(path.join(node.dataDir, "node.db"));
    try {
      database.prepare("UPDATE quick_notes SET status = 'failed', error = ? WHERE id = ?").run("Claude prompt failed after output", id);
    } finally { database.close(); }
    const pending = await api(node, auth, "POST", "/quick-notes", { ...input, title: "Still pending", scheduledAt: new Date(Date.now() + 3_600_000).toISOString() });
    assert.equal(pending.status, 201);
    await api(node, auth, "PUT", "/quick-notes/queue", { queue: { enabled: true, maxParallel: 1 } });
    const before = await readFile(log, "utf8");

    browser = await launchChrome({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const separator = auth.cookie.indexOf("=");
    await context.addCookies([{ name: auth.cookie.slice(0, separator), value: auth.cookie.slice(separator + 1), url: node.url }]);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const sentFrames: string[] = [];
    const starts: string[] = [];
    page.on("websocket", socket => socket.on("framesent", frame => sentFrames.push(String(frame.payload))));
    page.on("request", request => {
      if (request.method() === "POST" && /\/quick-notes\/[^/]+\/start$/.test(request.url())) starts.push(request.url());
    });
    await page.goto(node.url, { waitUntil: "domcontentloaded" });
    await page.locator(`[data-project-id="${project.id}"] .project-card`).click();
    await page.getByTestId("session-list-loading-bar").waitFor({ state: "hidden" });
    await page.getByTestId("notes-tab").click();
    const failed = page.getByTestId("quick-note-failed-runs");
    await failed.getByText("Failed after output", { exact: true }).waitFor();
    assert.deepEqual(await page.getByTestId("quick-note-pending").locator("strong").allTextContents(), ["Still pending"]);
    assert.equal(await failed.getByTestId("quick-note-start-button").count(), 0, "failed runs must not offer a new launch");
    assert.equal(await failed.getByTestId("quick-note-move-up").count(), 0, "failed runs are not queue entries");
    await failed.getByTestId("quick-note-open-conversation").click();
    await page.locator("#messages .message.user").filter({ hasText: input.content }).waitFor();
    const identity = await page.evaluate(async () => {
      const { state } = await import("/app/state.js");
      return state.activeSessionId;
    });
    assert.equal(identity, launched.body.sessionId, "open follows the original session, not a fresh draft");
    assert.equal(await page.getByTestId("quick-note-dialog").isVisible(), false);
    assert.deepEqual(starts, [], "opening never calls the launch endpoint");
    assert.equal(sentFrames.some(frame => JSON.parse(frame).type === "prompt"), false, "opening never sends a prompt");
    assert.equal(await readFile(log, "utf8"), before, "viewing does not invoke the engine again");

    assert.equal((await api(node, auth, "POST", `/quick-notes/${id}/start`)).status, 409, "API also rejects duplicate starts");
    assert.equal((await api(node, auth, "PATCH", `/quick-notes/${id}`, input)).status, 409, "editing cannot silently re-arm a consumed note");
    assert.equal(await readFile(log, "utf8"), before);

    // A missing transcript is an error, not permission to create a draft and rerun it.
    const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
    try { db.prepare("UPDATE quick_notes SET session_id = ? WHERE id = ?").run("missing-conversation", id); }
    finally { db.close(); }
    await page.getByTestId("notes-tab").click();
    await failed.getByTestId("quick-note-open-conversation").click();
    await page.getByText("The linked conversation is unavailable. Nothing was restarted.", { exact: true }).waitFor();
    assert.deepEqual(starts, []);
    assert.equal(await readFile(log, "utf8"), before);
  } finally {
    if (browser) await browser.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
