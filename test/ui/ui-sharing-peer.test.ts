import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";

test("three-member sharing revokes only the selected twin and preserves peer across refresh", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-sharing-peer-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    server = await startDevNode(environment, node);
    browser = await launchChrome({ headless: true });
    const session = await signIn(environment, node);
    assert.equal((await api(node, session, "POST", "/clusters", { name: "Home" })).status, 201);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
    const peers = [{ nodeId: "peer-a", name: "Alpha" }, { nodeId: "peer-b", name: "Beta" }];
    let members = peers;
    let relationships = peers.map(peer => ({ relationshipId: peer.nodeId, peer, status: "active" }));
    const revoked: string[] = [];
    // Three-member HTTP fixture exercises real DOM/actions, not backend replication.
    await page.route("**/api/clusters", async route => {
      const response = await route.fetch(); const data = await response.json();
      data.clusters[0].members.push(...members);
      await route.fulfill({ json: data });
    });
    await page.route("**/api/clusters/*/sharing", route => route.fulfill({ json: { projectAccess: [], projects: [], workspaces: [], projectIds: [], workspaceIds: [], pendingDeliveries: 0 } }));
    await page.route("**/api/twins", route => route.fulfill({ json: { relationships } }));
    await page.route("**/api/twins/*/sharing", route => route.fulfill({ json: { initialized: true, state: "ready", pendingDeliveries: 0, projectCount: 1, ownerNodeId: node.nodeId } }));
    await page.route(/\/api\/twins\/peer-[ab]$/, async route => {
      assert.equal(route.request().method(), "DELETE");
      const id = route.request().url().split("/").at(-1)!;
      revoked.push(id); relationships = relationships.filter(item => item.relationshipId !== id);
      await route.fulfill({ json: { status: "revoked", pending: false } });
    });
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.getByText("Internal Assistant", { exact: true }).waitFor();
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-cluster").click();
    await page.getByTestId("twin-sharing-status").first().waitFor();
    assert.equal(await page.getByTestId("twin-sharing-status").count(), 1, "show only chosen peer's relationship, not both active twins");
    for (const peer of peers) {
      await page.getByTestId(`cluster-member-twin-${peer.nodeId}`).waitFor();
      await page.getByTestId(`cluster-member-sync-${peer.nodeId}`).getByText("Up to date", { exact: true }).waitFor();
    }
    const peer = page.getByLabel("Sharing peer", { exact: true });
    assert.equal(await peer.inputValue(), "peer-a");
    await peer.selectOption("peer-b");
    await page.getByText("Twin · Beta", { exact: true }).waitFor();
    await page.getByTestId("sharing-refresh").click();
    await page.getByText("Twin · Beta", { exact: true }).waitFor();
    assert.equal(await peer.inputValue(), "peer-b");
    await page.getByTestId("sharing-mode-selected").click();
    await page.getByTestId("confirm-cancel-button").click(); assert.deepEqual(revoked, []);
    await page.getByTestId("sharing-mode-selected").click();
    await page.getByTestId("confirm-accept-button").click();
    await page.getByTestId("sharing-save").waitFor();
    assert.deepEqual(revoked, ["peer-b"]);
    assert.deepEqual(relationships.map(item => item.relationshipId), ["peer-a"]);
    await page.getByTestId("cluster-member-twin-peer-b").waitFor({ state: "detached" });
    await page.getByTestId("cluster-member-twin-peer-a").waitFor();
    assert.equal(await peer.inputValue(), "peer-b");
    assert.match(await page.getByTestId("cluster-sharing").innerText(), /all members of Home/);
    assert.match(await page.getByTestId("cluster-sharing").innerText(), /Alpha/);
    await page.getByTestId("sharing-refresh").click(); await page.getByTestId("sharing-save").waitFor();
    assert.equal(await peer.inputValue(), "peer-b");
    await peer.selectOption("peer-a"); await page.getByText("Twin · Alpha", { exact: true }).waitFor();
    assert.equal(await page.getByTestId("sharing-mode-twins").getAttribute("aria-pressed"), "true");
    members = [];
    await page.reload();
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-cluster").click();
    await page.getByText("No other nodes in this cluster", { exact: false }).waitFor();
    assert.equal(await page.getByTestId("sharing-mode-selected").count(), 0);
  } finally { await browser?.close(); if (server) await stopDevNode(server); await rm(root, { recursive: true, force: true }); }
});
