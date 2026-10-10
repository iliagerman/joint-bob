import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Browser } from "playwright-core";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";
import { launchChrome } from "./launch-chrome.js";

test("twin failures are readable in the member list, node inspector and machine view, and clear after recovery", { timeout: 150_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-twin-sync-ui-"));
  const servers: ChildProcess[] = [];
  let browser: Browser | undefined;
  try {
    const environment = await seedDevEnvironment(root, 2), [local, peer] = environment.nodes;
    servers.push(await startDevNode(environment, local), await startDevNode(environment, peer));
    const relationshipId = await pairTwinNodes(environment);
    const [signedIn, peerSession] = await Promise.all([signIn(environment, local), signIn(environment, peer)]);
    const cluster = await api<{ snapshot: { body: { clusterId: string } } }>(local, signedIn, "POST", "/clusters", { name: "Home" });
    assert.equal(cluster.status, 201);
    const invitation = await api<{ link: string }>(local, signedIn, "POST", `/clusters/${cluster.body.snapshot.body.clusterId}/invitations`, { expectedEpoch: 1 });
    assert.equal(invitation.status, 201);
    assert.equal((await api(peer, peerSession, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() })).status, 201);

    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", serviceWorkers: "block" });
    page.setDefaultTimeout(12_000);
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    let error: string | undefined = "Conversation history sync failed:\nContigos: aborted\nDak-Live: Cluster peer is unreachable";
    let readError = false, reads = 0, mutations = 0;
    let conflicts: Array<Record<string, string>> = [];
    const accepted: unknown[] = [];
    await page.route(`**/api/twins/${relationshipId}/transcript-conflicts/accept`, async route => {
      accepted.push(route.request().postDataJSON());
      conflicts = []; error = "Conversation history sync failed:\nDak-Live: Cluster peer is unreachable";
      await route.fulfill({ status: 200, json: { saved: "/data/transcript-conflicts/pi-4204caea.local.jsonl" } });
    });
    await page.route(`**/api/twins/${relationshipId}/sharing`, async route => {
      if (route.request().method() !== "GET") { mutations++; await route.continue(); return; }
      reads++;
      await route.fulfill({ status: readError ? 503 : 200, json: readError ? { error: "Peer status unavailable" } : {
        initialized: true, state: error ? "error" : "ready", projectCount: 3, pendingDeliveries: 0, ownerNodeId: local.nodeId, ...(error ? { error } : {}), ...(conflicts.length ? { conflicts } : {}),
      } });
    });
    await page.goto(local.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator(".project-card").first().waitFor();
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-cluster").click();
    await page.getByTestId("cluster-item").filter({ hasText: "Home" }).click();
    const member = page.locator(`[data-testid="cluster-member"][data-sharing-node-id="${peer.nodeId}"]`);
    await member.getByTestId(`cluster-member-sync-${peer.nodeId}`).waitFor();
    assert.equal(await member.getByTestId(`cluster-member-sync-${peer.nodeId}`).innerText(), "Error");
    const problem = member.getByTestId("twin-sync-problem");
    await problem.waitFor();
    assert.match(await problem.innerText(), /Contigos: aborted[\s\S]*Dak-Live: Cluster peer is unreachable/);
    assert.match(await problem.innerText(), /retries automatically/i);
    const before = reads;
    await problem.getByRole("button", { name: "Check again" }).click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="cluster-members"] [data-testid="twin-sync-check"]:disabled'));
    assert.ok(reads > before, "check again refreshes the status");
    assert.equal(mutations, 0, "checking an error never unpairs or reinitializes sharing");

    await page.getByTestId(`cluster-member-open-${peer.nodeId}`).click();
    const nodeView = page.locator(".cluster-node-view:visible");
    await nodeView.getByTestId("twin-sync-problem").waitFor();
    assert.match(await nodeView.getByTestId("twin-sync-problem").innerText(), /Contigos: aborted/);
    await page.getByTestId("cluster-map-local").click();
    await page.locator('[data-machine-tab="twins"]').click();
    await page.locator('[data-machine-panel="twins"]:visible').getByTestId("twin-sync-problem").waitFor();

    await page.getByTestId("cluster-item").filter({ hasText: "Home" }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    error = "Divergent transcript requires review: <img src=x onerror=alert(1)> " + "x".repeat(250);
    await problem.getByRole("button", { name: "Check again" }).click();
    await problem.getByText(error, { exact: true }).waitFor();
    assert.equal(await problem.locator("img").count(), 0, "peer error strings remain plain text");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, "long errors fit a phone");

    // A conversation both machines continued is named, and settled from here only on request.
    error = "Conversation history sync failed:\nContigos: Divergent transcript requires review";
    conflicts = [{ projectId: "contigos", projectName: "Contigos", engine: "pi", sessionId: "4204caea-3988-41a1-a149-c5c13a82c8e0", detectedAt: "2026-10-10T18:00:00.000Z", title: "Morning briefing" }];
    await problem.getByRole("button", { name: "Check again" }).click();
    const conflict = problem.getByTestId("twin-sync-conflict");
    await conflict.getByText("Contigos: Morning briefing", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, "conflict rows fit a phone");
    await conflict.getByTestId("twin-sync-conflict-accept").click();
    await page.getByTestId("confirm-cancel-button").click();
    assert.deepEqual(accepted, [], "nothing is replaced without confirmation");
    await conflict.getByTestId("twin-sync-conflict-accept").click();
    await page.getByTestId("confirm-accept-button").click();
    await problem.getByText(/Dak-Live: Cluster peer is unreachable/).waitFor();
    assert.equal(await problem.getByTestId("twin-sync-conflict").count(), 0, "a settled conversation leaves the list");
    assert.deepEqual(accepted, [{ projectId: "contigos", engine: "pi", sessionId: "4204caea-3988-41a1-a149-c5c13a82c8e0", confirmReplaceLocal: true }]);

    // A conflict the twin reports is settled on the twin; this machine only says so.
    error = "Conversation history sync failed:\nContigos: Divergent transcript requires review";
    await problem.getByRole("button", { name: "Check again" }).click();
    await problem.getByText("A conversation was continued on both machines. Settle it from the other machine's Settings, under Cluster.", { exact: true }).waitFor();
    assert.equal(await problem.getByTestId("twin-sync-conflict-accept").count(), 0);

    readError = true;
    await problem.getByRole("button", { name: "Check again" }).click();
    await problem.getByText("Could not check synchronization: Peer status unavailable", { exact: true }).waitFor();
    readError = false; error = undefined;
    await problem.getByRole("button", { name: "Check again" }).click();
    await member.getByTestId(`cluster-member-sync-${peer.nodeId}`).getByText("Up to date", { exact: true }).waitFor();
    assert.equal(await problem.count(), 0, "the error explanation disappears after recovery");
    assert.equal(mutations, 0);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser?.close();
    await Promise.allSettled(servers.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
