import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";
import { launchChrome } from "./launch-chrome.js";

test("conversation conflicts offer safe choices and require explicit replacement confirmation", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-conflict-choices-"));
  const environment = await seedDevEnvironment(root, 1);
  const server = await startDevNode(environment, environment.nodes[0]);
  let browser;
  try {
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
    page.setDefaultTimeout(10_000);
    const errors: string[] = [], accepted: unknown[] = [], forked: unknown[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/twins", route => route.fulfill({ json: { relationships: [{ relationshipId: "twin", status: "active", peer: { name: "Homeserver", nodeId: "owner" } }] } }));
    await page.route("**/api/twins/twin/sharing", route => route.fulfill({ json: { conflicts: [{ projectId: "project", engine: "pi", sessionId: "session" }] } }));
    await page.route("**/api/twins/twin/transcript-conflicts/accept", async route => {
      accepted.push(route.request().postDataJSON());
      await route.fulfill({ json: { saved: "/backup/local.jsonl" } });
    });
    await page.route("**/api/twins/twin/transcript-conflicts/fork", async route => {
      forked.push(route.request().postDataJSON());
      await route.fulfill({ status: 201, json: { session: { id: "forked", title: "[Local fork] Original" } } });
    });
    await page.goto(environment.nodes[0].url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator(".project-card").first().waitFor();
    const show = async () => { await page.evaluate(async () => {
      await new Promise(requestAnimationFrame);
      const socketPath = "/app/socket.js", statePath = "/app/state.js";
      const { handleSocketPayload } = await import(socketPath);
      const { state } = await import(statePath);
      const before = { activeProjectId: state.activeProjectId, engine: state.engine, activeSessionId: state.activeSessionId };
      Object.assign(state, { activeProjectId: "project", engine: "pi", activeSessionId: "session" });
      handleSocketPayload({ type: "error", error: "Divergent transcript requires review" });
      Object.assign(state, before);
    }); await page.locator("#choiceDialog").waitFor({ state: "visible" }); };
    await show();
    const choice = page.locator("#choiceDialog");
    await choice.getByText("This conversation has two histories", { exact: true }).waitFor();
    assert.equal(await choice.locator('input[value="keep"]').isChecked(), true, "default leaves both histories untouched");
    await choice.getByText("Decide later", { exact: true }).waitFor();
    await choice.getByText(/Homeserver owns this conversation/).waitFor();
    await choice.getByText("Use Homeserver's history", { exact: true }).waitFor();
    await page.getByTestId("choice-accept-button").click();
    assert.deepEqual(accepted, []);
    await show();
    await choice.locator('input[value="owner"]').check();
    await page.getByTestId("choice-accept-button").click();
    await page.getByTestId("confirm-cancel-button").click();
    await page.locator("#confirmDialog").waitFor({ state: "hidden" });
    assert.deepEqual(accepted, [], "cancelling confirmation never replaces history");
    await show();
    await choice.locator('input[value="owner"]').check();
    await page.getByTestId("choice-accept-button").click();
    await page.getByTestId("confirm-accept-button").click();
    await page.getByText(/History reconciled\. Backup: \/backup\/local.jsonl/).waitFor();
    assert.deepEqual(accepted, [{ projectId: "project", engine: "pi", sessionId: "session", confirmReplaceLocal: true }]);
    // A failure to apply the choice stays visible, without replaying the mutation.
    await page.route("**/api/twins/twin/transcript-conflicts/accept", async route => {
      accepted.push(route.request().postDataJSON());
      await route.fulfill({ status: 409, json: { error: "This machine's copy changed since it was compared; check again" } });
    });
    await show();
    await choice.locator('input[value="owner"]').check();
    await page.getByTestId("choice-accept-button").click();
    await page.getByTestId("confirm-accept-button").click();
    await page.getByText(/Could not reconcile history: This machine's copy changed/).waitFor();
    assert.equal(accepted.length, 2, "failed replacement is not retried automatically");
    await show();
    await choice.locator('input[value="fork"]').check();
    await page.getByTestId("choice-accept-button").click();
    await page.getByText(/Created \[Local fork\] Original/).waitFor();
    assert.deepEqual(forked, [{ projectId: "project", engine: "pi", sessionId: "session" }]);
    assert.equal(accepted.length, 2, "forking never replaces the original history");
    // A remotely detected transfer conflict must not depend on this page's local
    // conflict list. Choosing the Mac copy replaces only after a second confirmation.
    await page.route("**/api/twins/twin/sharing", route => route.fulfill({ json: { conflicts: [] } }));
    await page.reload();
    await page.locator(".project-card").first().waitFor();
    const transfers: unknown[] = [];
    await page.route("**/api/projects/project/sessions/take-ownership", async route => {
      transfers.push(route.request().postDataJSON());
      await route.fulfill({ json: { saved: "/backup/homeserver.jsonl" } });
    });
    const transferConflict = async () => {
      await page.evaluate(`(() => {
        const modulePath = "/app/transcript-conflict.js";
        window.transferConflictDone = import(modulePath).then(({ reconcileTranscriptConflict }) => reconcileTranscriptConflict("Divergent transcript requires review", {
          projectId: "project", engine: "pi", sessionId: "session",
          transfer: { ownerName: "Mac", destinationName: "Homeserver", accept: async () => {
            const apiPath = "/app/api.js";
            const { api } = await import(apiPath);
            await api("/api/projects/project/sessions/take-ownership", { method: "POST", body: JSON.stringify({ peerId: "destination", sessionId: "session", sessionPath: "pi:session", historyOwnerNodeId: "mac" }) });
          } },
        }));
      })()`);
      await choice.waitFor({ state: "visible" }).catch(error => { throw new Error(`${error.message}\nPage errors: ${JSON.stringify(errors)}`); });
    };
    await transferConflict();
    await choice.getByText("Use Mac's history and transfer to Homeserver", { exact: true }).waitFor();
    const useMac = choice.locator('input[value="owner"]');
    assert.equal(await useMac.isEnabled(), true, "remote conflict offers the source copy even with no local conflict rows");
    await useMac.check();
    await page.getByTestId("choice-accept-button").click();
    await page.getByTestId("confirm-cancel-button").click();
    await page.locator("#confirmDialog").waitFor({ state: "hidden" });
    await page.evaluate("window.transferConflictDone");
    assert.deepEqual(transfers, [], "cancelling never retries or replaces history");
    await transferConflict();
    await choice.locator('input[value="owner"]').check();
    await page.getByTestId("choice-accept-button").click();
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith("/sessions/take-ownership") && response.request().method() === "POST"),
      page.getByTestId("confirm-accept-button").click(),
    ]);
    assert.equal(transfers.length, 1);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
