import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";

test("sharing controls require consent and render selected scopes and legacy enable, automatic sync status and retry", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-sharing-ui-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    server = await startDevNode(environment, node);
    browser = await launchChrome({ headless: true });
    const session = await signIn(environment, node);
    const cluster = await api<{ snapshot: { body: { clusterId: string } } }>(node, session, "POST", "/clusters", { name: "Home" });
    assert.equal(cluster.status, 201);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
    // Controlled HTTP boundary for pending/error states; real disposable server serves the UI.
    let selection = { projects: [{ id: "p1", name: "Owned project", workspaceId: "w1" }], workspaces: [{ id: "w1", label: "Work" }], projectIds: [] as string[], workspaceIds: [] as string[], pendingDeliveries: 0 };
    let relationships: object[] = [];
    let completion = "pending", initialized = false, failRead = false;
    let writes = 0, completions = 0, revocations = 0, acceptances = 0;
    await page.route("**/api/clusters", async route => {
      const response = await route.fetch(); const data = await response.json();
      data.clusters[0].members.push({ nodeId: "homeserver", name: "Homeserver" });
      data.clusters[0].managerNodeId = "homeserver";
      await route.fulfill({ json: data });
    });
    await page.route("**/api/clusters/*/sharing", async route => {
      if (route.request().method() === "PUT") { const body = route.request().postDataJSON(); assert.equal(body.confirmOwnedData, true); selection = { ...selection, projectIds: body.projectIds, workspaceIds: body.workspaceIds }; writes++; }
      await route.fulfill({ json: selection });
    });
    await page.route("**/api/twins", route => route.fulfill({ json: { relationships } }));
    await page.route("**/api/twins/accept", async route => {
      assert.deepEqual(route.request().postDataJSON(), { link: "synthetic-twin-invitation", confirmOwnedData: true });
      acceptances++; initialized = true; completion = "pending";
      relationships = [{ relationshipId: "r1", peer: { nodeId: "homeserver", name: "Homeserver" }, status: "active" }];
      await route.fulfill({ status: 201, json: { status: "active" } });
    });
    await page.route("**/api/twins/r1/sharing", async route => {
      if (failRead) { await route.fulfill({ status: 503, json: { error: "Status service unavailable" } }); return; }
      if (route.request().method() === "POST") { assert.equal(route.request().postDataJSON().confirmOwnedData, true); assert.equal(route.request().postDataJSON().ownerNodeId, completions === 0 ? "homeserver" : node.nodeId, "retry preserves established owner even when manager differs"); completions++; initialized = true; completion = completions === 1 ? "error" : "pending"; }
      await route.fulfill({ json: { initialized, state: completion, ownerNodeId: node.nodeId, projectCount: 1, pendingDeliveries: completion === "pending" ? 1 : 0, ...(completion === "error" ? { error: "Peer unavailable" } : {}) } });
    });
    await page.route("**/api/twins/r1", async route => { assert.equal(route.request().method(), "DELETE"); revocations++; relationships = []; await route.fulfill({ json: { status: "revoked", pending: false } }); });
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.getByText("Internal Assistant", { exact: true }).waitFor();
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-cluster").click();
    await page.getByTestId("sharing-mode-selected").waitFor({ timeout: 5000 });
    await page.getByTestId("sharing-project-p1").check();
    await page.getByTestId("sharing-workspace-w1").check();
    await page.getByTestId("sharing-save").click();
    await page.getByTestId("confirm-cancel-button").click();
    assert.equal(writes, 0);
    await page.getByTestId("sharing-save").click();
    await page.getByTestId("confirm-accept-button").click();
    await page.getByTestId("sharing-status").getByText("Selection saved", { exact: false }).waitFor();
    assert.deepEqual(selection.projectIds, ["p1"]); assert.deepEqual(selection.workspaceIds, ["w1"]);
    await page.getByTestId("sharing-project-p1").uncheck();
    await page.getByTestId("sharing-workspace-w1").uncheck();
    await page.getByTestId("sharing-save").click();
    const removed = page.waitForResponse(response => response.url().endsWith("/sharing") && response.request().method() === "PUT");
    await page.getByTestId("confirm-accept-button").click(); await removed;
    await page.getByTestId("sharing-status").getByText("Selection saved", { exact: false }).waitFor();
    assert.deepEqual(selection.projectIds, []); assert.deepEqual(selection.workspaceIds, []);
    relationships = [{ relationshipId: "r1", peer: { nodeId: "homeserver", name: "Homeserver" }, status: "active" }];
    await page.getByTestId("sharing-refresh").click();
    await page.getByRole("button", { name: "Enable sharing", exact: true }).waitFor({ timeout: 5000 });
    assert.equal(await page.getByTestId("twin-sharing-owner").inputValue(), "homeserver", "legacy owner defaults to cluster manager");
    await page.getByText("Approval complete. This existing twin needs no second invitation or approval.", { exact: true }).waitFor();
    assert.match(await page.getByTestId("twin-data-sharing").innerText(), /Sharing not started/);
    assert.match(await page.getByTestId("twin-sharing-status").innerText(), /1 Twin-shared projects/);
    await page.getByTestId("cluster-details").getByText("Cluster-shared projects on this node · 0", { exact: true }).waitFor();
    await page.getByTestId("twin-sharing-owner").selectOption(node.nodeId);
    const poll = page.waitForResponse(response => response.url().endsWith("/api/twins/r1/sharing"));
    await poll;
    assert.equal(await page.getByTestId("twin-sharing-owner").inputValue(), node.nodeId, "poll preserves unfinished owner selection");
    await page.getByTestId("twin-sharing-owner").selectOption("homeserver");
    assert.equal(await page.getByText("Up to date", { exact: true }).count(), 0);
    await page.getByTestId("twin-enable-sharing").click(); await page.getByTestId("confirm-cancel-button").click(); assert.equal(completions, 0);
    await page.getByTestId("twin-enable-sharing").click(); await page.getByTestId("confirm-accept-button").click();
    await page.getByTestId("twin-sharing-status").getByText("Peer unavailable", { exact: false }).waitFor(); assert.equal(completions, 1);
    assert.equal(await page.getByTestId("twin-sharing-owner").count(), 0, "established owner cannot be reassigned on retry");
    await page.getByTestId("twin-retry-sharing").click(); await page.getByTestId("confirm-accept-button").click();
    await page.getByTestId("twin-sharing-status").getByText("Syncing", { exact: false }).waitFor(); assert.equal(completions, 2);
    completion = "ready";
    await page.getByTestId("twin-sharing-status").getByText("Up to date", { exact: false }).waitFor({ timeout: 10000 });
    await page.getByTestId("cluster-member-sync-homeserver").getByText("Up to date", { exact: false }).waitFor();
    assert.equal(await page.getByTestId("cluster-member-twin-homeserver").innerText(), "Twin");
    failRead = true;
    await page.getByTestId("twin-sharing-status").getByText("Status service unavailable", { exact: false }).waitFor({ timeout: 10000 });
    assert.doesNotMatch(await page.getByTestId("twin-sharing-status").innerText(), /Up to date/);
    failRead = false;
    await page.getByTestId("twin-sharing-status").getByText("Up to date", { exact: false }).waitFor({ timeout: 10000 });
    completion = "error";
    await page.getByTestId("twin-sharing-status").getByText("Peer unavailable", { exact: false }).waitFor({ timeout: 10000 });
    await page.getByTestId("cluster-member-sync-homeserver").getByText("Error", { exact: false }).waitFor();
    await page.getByTestId("sharing-mode-selected").click(); await page.getByTestId("confirm-cancel-button").click(); assert.equal(revocations, 0);
    await page.getByTestId("sharing-mode-selected").click(); await page.getByTestId("confirm-accept-button").click();
    await page.getByTestId("sharing-save").waitFor(); assert.equal(revocations, 1);
    await page.getByTestId("sharing-mode-twins").click();
    await page.getByTestId("twin-invite").click(); await page.getByTestId("confirm-cancel-button").click();
    await page.getByTestId("twin-link").waitFor();
    for (const id of ["twin-link", "twin-accept-link", "cluster-invite-link-input", "cluster-join-link-input"]) {
      const field = page.getByTestId(id);
      assert.ok(await field.getAttribute("name"), `${id} has a meaningful form name`);
      assert.equal(await field.getAttribute("autocomplete"), "off");
      assert.equal(await field.getAttribute("spellcheck"), "false");
      assert.ok(await field.evaluate((element: HTMLInputElement) => element.labels?.length), `${id} has a native label`);
    }
    await page.getByTestId("cluster-sharing").getByText("What stays local", { exact: true }).click();
    assert.match(await page.getByTestId("cluster-sharing").innerText(), /Browser profiles, website credentials and machine-local identities stay local/);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("twin-accept-link").scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, "sharing controls fit mobile viewport");
    await page.getByTestId("twin-accept-link").fill("synthetic-twin-invitation");
    await page.getByTestId("twin-accept").click(); await page.getByTestId("confirm-cancel-button").click(); assert.equal(acceptances, 0);
    await page.getByTestId("twin-accept").click(); await page.getByTestId("confirm-accept-button").click();
    await page.getByTestId("twin-sharing-status").getByText("Syncing", { exact: false }).waitFor();
    assert.equal(acceptances, 1);
    assert.equal(completions, 2, "acceptance needs no extra sharing POST");
    assert.equal(await page.getByRole("button", { name: /Complete sharing/i }).count(), 0, "acceptance must not offer a manual completion step");
    assert.equal(await page.getByTestId("twin-enable-sharing").count(), 0);
    completion = "ready";
    await page.getByTestId("twin-sharing-status").getByText("Up to date", { exact: false }).waitFor({ timeout: 10000 });
  } finally { await browser?.close(); if (server) await stopDevNode(server); await rm(root, { recursive: true, force: true }); }
});
