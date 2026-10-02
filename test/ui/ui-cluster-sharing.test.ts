import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";

const homeserver = "11111111-1111-4111-8111-111111111111";
const beta = "22222222-2222-4222-8222-222222222222";

test("cluster sharing is one selection for the whole cluster, and twin states, requests and unpairing act per twin", { timeout: 150_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-cluster-sharing-ui-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    server = await startDevNode(environment, node);
    const session = await signIn(environment, node);
    assert.equal((await api(node, session, "POST", "/clusters", { name: "Home" })).status, 201);
    browser = await launchChrome({ headless: process.env.HEADED !== "1" });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
    page.setDefaultTimeout(15_000);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    // A controlled HTTP boundary for states two real nodes cannot reach on demand; the real server serves the page.
    const calls: string[] = [];
    let selection = { projectAccess: [], projects: [{ id: "p1", name: "Owned project", workspaceId: "w1" }], workspaces: [{ id: "w1", label: "Work" }], projectIds: [] as string[], workspaceIds: [] as string[], pendingDeliveries: 0 };
    for (let index = 0; index < 30; index++) {
      selection.projects.push({ id: `extra-p${index}`, name: `Extra project ${index}`, workspaceId: `extra-w${index}` });
      selection.workspaces.push({ id: `extra-w${index}`, label: `Extra workspace ${index}` });
    }
    let relationships = [{ relationshipId: "r1", peer: { nodeId: homeserver }, status: "active" }];
    let requests = [{ relationshipId: "q1", direction: "incoming", peerNodeId: beta, peerName: "Beta", clusterId: "", expiresAt: Date.now() + 600_000 }];
    let twin = { initialized: false, state: "pending", ownerNodeId: node.nodeId, projectCount: 2, pendingDeliveries: 1 } as Record<string, unknown>;
    let failRead = false, sharingPosts = 0;
    await page.route("**/api/clusters", async (route) => {
      const response = await route.fetch(); const data = await response.json();
      data.clusters[0].members.push({ nodeId: homeserver, name: "Homeserver", url: "https://homeserver.test", joinSequence: 2 }, { nodeId: beta, name: "Beta", url: "https://beta.test", joinSequence: 3 });
      data.clusters[0].managerNodeId = homeserver;
      for (const item of requests) item.clusterId ||= data.clusters[0].id;
      await route.fulfill({ json: data });
    });
    await page.route("**/api/clusters/*/sharing", async (route) => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON(); assert.equal(body.confirmOwnedData, true);
        selection = { ...selection, projectIds: body.projectIds, workspaceIds: body.workspaceIds }; calls.push("put-sharing");
      }
      await route.fulfill({ json: selection });
    });
    await page.route("**/api/clusters/*/membership", async (route) => { calls.push(`patch-membership:${route.request().postDataJSON().autoShareProjects}`); await route.fulfill({ json: { ok: true } }); });
    await page.route("**/api/twins", (route) => route.fulfill({ json: { relationships } }));
    await page.route("**/api/twins/requests", (route) => route.fulfill({ json: { requests } }));
    await page.route("**/api/twins/requests/q1/accept", async (route) => {
      assert.deepEqual(route.request().postDataJSON(), { confirmOwnedData: true });
      calls.push("accept"); requests = []; relationships = [...relationships, { relationshipId: "r2", peer: { nodeId: beta }, status: "active" }];
      await route.fulfill({ status: 201, json: { relationshipId: "r2", status: "active" } });
    });
    await page.route("**/api/cluster/inventory", (route) => route.fulfill({ json: { local: { name: node.name, url: node.url }, remote: [
      { peerId: homeserver, name: "Homeserver", url: "https://homeserver.test", reachable: true },
      { peerId: beta, name: "Beta", url: "https://beta.test", reachable: false, error: "Peer unavailable" }] } }));
    await page.route("**/api/twins/r1/sharing", async (route) => {
      if (failRead) { await route.fulfill({ status: 503, json: { error: "Status service unavailable" } }); return; }
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON(); assert.equal(body.confirmOwnedData, true);
        calls.push(`sharing:${body.ownerNodeId}`);
        twin = ++sharingPosts === 1 ? { ...twin, initialized: true, state: "error", error: "Peer unavailable" } : { ...twin, initialized: true, state: "pending", error: undefined };
      }
      await route.fulfill({ json: twin });
    });
    await page.route("**/api/twins/r2/sharing", (route) => route.fulfill({ json: { initialized: true, state: "ready", pendingDeliveries: 0, projectCount: 1, ownerNodeId: node.nodeId } }));
    await page.route(/\/api\/twins\/r[12]$/, async (route) => {
      assert.equal(route.request().method(), "DELETE");
      const id = route.request().url().split("/").at(-1)!;
      calls.push(`unpair:${id}`); relationships = relationships.filter((item) => item.relationshipId !== id);
      await route.fulfill({ json: { status: "revoked", pending: false } });
    });

    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.getByText("Internal Assistant", { exact: true }).waitFor();
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-cluster").click();
    // The map selects a cluster or this machine; the inspector shows one section at a time.
    const showClusterNodes = async () => { await page.getByTestId("cluster-item").first().click(); await page.getByTestId("cluster-tab-nodes").click(); };
    const showTwins = async () => { await page.getByTestId("cluster-map-local").click(); await page.getByTestId("cluster-machine-tab-twins").click(); };
    await page.getByTestId("cluster-tab-sharing").click();
    await page.getByTestId("sharing-save").waitFor();

    // One selection for the whole cluster, with long lists that scroll and search.
    const sharing = page.getByTestId("cluster-sharing");
    assert.match(await sharing.innerText(), /shared with every node in Home \(Homeserver, Beta\)[\s\S]*no per-node sharing/);
    assert.equal(await page.getByLabel("Sharing peer").count(), 0, "there is no per-node sharing picker");
    for (const kind of ["project", "workspace"]) {
      const list = page.getByTestId(`sharing-${kind}-list`).locator(".cluster-scroll-list");
      const geometry = await list.evaluate((element) => ({ height: element.clientHeight, scroll: element.scrollHeight }));
      assert.ok(geometry.scroll > geometry.height && geometry.height <= 300, `${kind}: ${JSON.stringify(geometry)}`);
      await page.getByTestId(`sharing-${kind}-search`).fill(`xtr ${kind} 29`);
      assert.equal(await list.locator(".checkbox-row:visible").count(), 1);
      await page.getByTestId(`sharing-${kind}-search`).fill("");
    }
    await page.getByTestId("sharing-project-p1").check();
    await page.getByTestId("sharing-workspace-w1").check();
    await page.getByTestId("cluster-auto-share-input").check();
    // A twin poll must not reset an unsaved selection.
    await page.waitForResponse((response) => response.url().endsWith("/api/twins/requests"));
    await page.waitForResponse((response) => response.url().endsWith("/api/twins/requests"));
    assert.equal(await page.getByTestId("sharing-project-p1").isChecked(), true, "polling keeps the unsaved selection");
    await page.getByTestId("sharing-save").click();
    await page.getByTestId("confirm-cancel-button").click();
    assert.deepEqual(calls, []);
    await page.getByTestId("sharing-save").click();
    await page.getByTestId("confirm-accept-button").click();
    // The sharing panel is replaced by the refreshed response; its inline status is transient.
    await page.getByText("Sharing with Home saved", { exact: true }).waitFor();
    await page.getByTestId("sharing-save").waitFor();
    assert.deepEqual(calls.splice(0), ["put-sharing", "patch-membership:true"], "automatic sharing is applied after the selection that resets it");
    assert.deepEqual([selection.projectIds, selection.workspaceIds], [["p1"], ["w1"]]);

    // An incoming request shows as a banner and on the requesting node's row.
    const banner = page.getByTestId("cluster-twin-request");
    assert.match(await banner.innerText(), /Beta asks to be twins with this node \(via Home\)/);
    await page.getByTestId("cluster-tab-nodes").click();
    await page.getByTestId(`cluster-member-accept-${beta}`).waitFor();
    await page.getByTestId(`cluster-member-twin-${homeserver}`).waitFor();
    assert.equal(await page.getByTestId(`cluster-member-sync-${homeserver}`).innerText(), "Not enabled");
    assert.equal(await page.getByTestId("cluster-map-twin").count(), 1, "the map shows the twin above this node");

    // The existing twin never started sharing: this machine's Twins tab chooses the original owner and enables it.
    await showTwins();
    const twins = page.getByTestId("cluster-nodes");
    const homeRow = twins.getByTestId("cluster-node-row").filter({ hasText: "Homeserver" });
    await homeRow.getByText("Connected", { exact: true }).waitFor();
    assert.match(await homeRow.getByTestId("twin-sharing-status").innerText(), /Not enabled · 2 twin-shared projects/);
    await homeRow.getByTestId("twin-sharing-owner").selectOption(homeserver);
    await page.waitForResponse((response) => response.url().endsWith("/api/twins/requests"));
    assert.equal(await homeRow.getByTestId("twin-sharing-owner").inputValue(), homeserver, "polling keeps an unfinished owner choice");
    await homeRow.getByTestId("twin-enable-sharing").click();
    await page.getByTestId("confirm-cancel-button").click();
    assert.deepEqual(calls, []);
    await homeRow.getByTestId("twin-enable-sharing").click();
    await page.getByTestId("confirm-accept-button").click();
    await homeRow.getByTestId("twin-sharing-status").getByText("Peer unavailable", { exact: false }).waitFor();
    assert.deepEqual(calls.splice(0), [`sharing:${homeserver}`]);
    assert.equal(await homeRow.getByTestId("twin-sharing-owner").count(), 0, "an established owner cannot be reassigned on retry");
    assert.match(await homeRow.getByTestId("twin-sharing-status").innerText(), /^Error/);
    await homeRow.getByTestId("twin-retry-sharing").click();
    await page.getByTestId("confirm-accept-button").click();
    await homeRow.getByTestId("twin-sharing-status").getByText("Syncing", { exact: false }).waitFor();
    assert.deepEqual(calls.splice(0), [`sharing:${node.nodeId}`], "retry keeps the owner the twin already has");
    twin = { ...twin, state: "ready", pendingDeliveries: 0 };
    await homeRow.getByTestId("twin-sharing-status").getByText("Up to date", { exact: false }).waitFor({ timeout: 10_000 });
    failRead = true;
    await homeRow.getByTestId("twin-sharing-status").getByText("Status service unavailable", { exact: false }).waitFor({ timeout: 10_000 });
    await showClusterNodes();
    assert.equal(await page.getByTestId(`cluster-member-sync-${homeserver}`).innerText(), "Error");
    failRead = false;
    await page.getByTestId(`cluster-member-sync-${homeserver}`).getByText("Up to date", { exact: true }).waitFor({ timeout: 10_000 });

    // Accepting Beta's request makes a second twin; unpairing one leaves the other.
    await banner.getByTestId("cluster-twin-request-accept").click();
    await page.getByTestId("confirm-accept-button").click();
    await page.getByTestId(`cluster-member-twin-${beta}`).waitFor();
    assert.equal(await banner.count(), 0);
    assert.equal(await page.getByTestId("cluster-map-twin").count(), 2);
    await showTwins();
    const betaRow = twins.getByTestId("cluster-node-row").filter({ hasText: "Beta" });
    assert.match(await betaRow.getByTestId("cluster-node-status").innerText(), /Not connected — Peer unavailable/);
    assert.equal(await betaRow.getAttribute("data-state"), "offline");
    await showClusterNodes();
    await page.getByTestId(`cluster-member-unpair-${beta}`).click();
    await page.getByTestId("confirm-cancel-button").click();
    assert.deepEqual(calls.splice(0), ["accept"]);
    await page.getByTestId(`cluster-member-unpair-${beta}`).click();
    await page.getByTestId("confirm-accept-button").click();
    await page.getByTestId(`cluster-member-make-twin-${beta}`).waitFor();
    assert.deepEqual(calls.splice(0), ["unpair:r2"], "only the chosen twin is unpaired");
    await page.getByTestId(`cluster-member-twin-${homeserver}`).waitFor();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("cluster-inspector").scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, "the cluster page fits a phone");
    assert.deepEqual(pageErrors, []);
  } finally { await browser?.close(); if (server) await stopDevNode(server); await rm(root, { recursive: true, force: true }); }
});
