import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";
import { launchChrome } from "./launch-chrome.js";

test("takeover counts only its working folder, cancels cleanly, and surfaces status failures", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ownership-sync-"));
  const environment = await seedDevEnvironment(root, 1);
  const server = await startDevNode(environment, environment.nodes[0]);
  let browser;
  try {
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
    page.setDefaultTimeout(10_000);
    const errors: string[] = [], scopedRequests: string[] = [], transfers: unknown[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(environment.nodes[0].url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.waitForFunction(async () => {
      const modulePath = "/app/state.js";
      const { state } = await import(modulePath);
      return state.authenticated && state.preferencesLoaded;
    });
    await page.locator("#loginDialog").waitFor({ state: "hidden" });
    await page.evaluate(async () => {
      const modulePath = "/app/chat-controls.js";
      await (await import(modulePath)).loadHarnesses();
    });
    const projectId = "scope-fixture", worktreeId = "11111111-1111-4111-8111-111111111111";
    let remaining = 3, failStatus = false;
    let holdStatus: Promise<void> | undefined;
    await page.route(`**/api/projects/${projectId}`, route => route.fulfill({ json: { project: {
      id: projectId, syncStatus: { engine: "builtin", state: "syncing", remainingFiles: 77569, remainingBytes: 869164646 },
    } } }));
    await page.route(`**/api/projects/${projectId}/sync/status*`, async route => {
      scopedRequests.push(new URL(route.request().url()).search);
      await holdStatus;
      await route.fulfill(failStatus ? { status: 503, json: { error: "File sync worker unavailable" } } : { json: {
        syncStatus: { engine: "builtin", state: remaining ? "syncing" : "synced", remainingFiles: remaining, remainingBytes: remaining * 1024 },
      } });
    });
    await page.route(`**/api/projects/${projectId}/sessions/take-ownership`, async route => {
      transfers.push(route.request().postDataJSON());
      // Stop before opening a fixture transcript; the real cross-node transfer is covered by ui-cluster-login.
      await route.fulfill({ status: 409, json: { error: "Fixture takeover reached" } });
    });
    const show = async (inWorktree: boolean) => page.evaluate(async ({ projectId, worktreeId, inWorktree }) => {
      const statePath = "/app/state.js", controlsPath = "/app/chat-controls.js";
      const { state } = await import(statePath);
      const { renderConversationLock } = await import(controlsPath);
      Object.assign(state, {
        activeProjectId: projectId, activeSessionId: "session", activeSessionPath: "pi:session", activeNodeId: "mac", activeTaskId: null,
        projects: [{ id: projectId, syncStatus: { engine: "builtin" } }],
        sessions: [{ id: "session", path: "pi:session", harnessId: "pi", title: "Ela", ...(inWorktree ? { worktree: { id: worktreeId, name: "Legal", color: "blue" } } : {}) }],
        sessionNodes: [{ id: "mac", name: "Mac", local: true, mapped: true }],
        conversationLock: { nodeId: "owner", nodeName: "Homeserver", status: "owned" },
      });
      renderConversationLock();
    }, { projectId, worktreeId, inWorktree });
    const take = page.getByTestId("conversation-lock-take-button");
    const status = page.locator("#conversationLockStatus");
    await show(true);
    // Click the real control even though this focused fixture does not navigate the project list.
    await take.dispatchEvent("click");
    await page.waitForFunction(() => /files,/.test(document.querySelector("#conversationLockStatus")!.textContent!));
    assert.equal(await status.textContent(), "Copying files to Mac: 3 files, 3.0 KB left…");
    assert.deepEqual(scopedRequests, [`?worktreeId=${worktreeId}`]);
    await take.dispatchEvent("click");
    await page.waitForFunction(() => document.querySelector("#conversationLockTakeButton")!.textContent === "Take ownership");
    assert.deepEqual(transfers, [], "cancelling a wait never transfers ownership");

    remaining = 0;
    await show(false);
    await take.dispatchEvent("click");
    await page.getByText("Fixture takeover reached", { exact: true }).waitFor();
    assert.equal(scopedRequests.at(-1), "", "a normal conversation checks the main project only");
    assert.equal(transfers.length, 1, "unrelated worktrees do not hold a normal conversation");

    failStatus = true;
    await show(true);
    await take.dispatchEvent("click");
    await page.getByText("File sync worker unavailable", { exact: true }).waitFor();
    assert.equal(transfers.length, 1, "a failed readiness request does not silently transfer ownership");

    failStatus = false;
    await show(true);
    let release!: () => void;
    holdStatus = new Promise<void>(resolve => { release = resolve; });
    const requested = page.waitForRequest(request => request.url().includes(`/projects/${projectId}/sync/status`));
    await take.dispatchEvent("click");
    await requested;
    await take.dispatchEvent("click");
    const responded = page.waitForResponse(response => response.url().includes(`/projects/${projectId}/sync/status`));
    release();
    await responded;
    await page.waitForFunction(async () => {
      const modulePath = "/app/state.js";
      const { shared } = await import(modulePath);
      return !shared.ownershipWait && !shared.ownershipTaking;
    });
    assert.equal(transfers.length, 1, "a status result arriving after cancellation cannot transfer ownership");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
