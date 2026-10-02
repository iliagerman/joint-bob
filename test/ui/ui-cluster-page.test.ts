import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type Browser, type Page } from "playwright-core";
import type { SessionSummary } from "../../src/types.js";
import { launchChrome } from "./launch-chrome.js";
import { multiSelect } from "./multi-select.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode, type SignedIn } from "../dev-nodes.js";

interface SnapshotResponse { snapshot: { body: { clusterId: string } } }
interface ProjectView { id: string; name: string; locallyOwned?: boolean; clusterIds?: string[] }

async function expectStatus<T>(request: Promise<{ status: number; body: T }>, status: number, label: string): Promise<T> {
  const response = await request;
  assert.equal(response.status, status, `${label} returned ${response.status}: ${JSON.stringify(response.body)}`);
  return response.body;
}

async function sharedProject(node: SeededNode, session: SignedIn, name: string, clusterId: string | null): Promise<string> {
  const { project } = await expectStatus(api<{ project: { id: string } }>(node, session, "POST", "/projects", { name, type: "personal", synced: false }), 201, `create ${name}`);
  if (clusterId) {
    await expectStatus(api(node, session, "PUT", `/sharing/project/${project.id}`, { expectedGeneration: 1, shares: [{ clusterId, projectId: null }] }), 200, `share ${name}`);
  }
  return project.id;
}

async function waitFor<T>(read: () => Promise<T | undefined>, message: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new assert.AssertionError({ message });
}

async function openClusterSettings(page: Page): Promise<void> {
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-cluster").click();
  await page.getByTestId("cluster-item").first().waitFor();
}

test("cluster page lists clusters, finds nodes fuzzily, splits what you get from what you share, and drives the list filters", { timeout: 240_000 }, async () => {
  const roots: string[] = [];
  const servers: ChildProcess[] = [];
  let browser: Browser | undefined;
  try {
    for (const name of ["a", "b"]) roots.push(await mkdtemp(path.join(os.tmpdir(), `joint-bob-ui-cluster-page-${name}-`)));
    const [environmentA, environmentB] = await Promise.all(roots.map((root) => seedDevEnvironment(root, 1)));
    const [nodeA, nodeB] = [environmentA.nodes[0], environmentB.nodes[0]];
    servers.push(await startDevNode(environmentA, nodeA), await startDevNode(environmentB, nodeB));
    const [sessionA, sessionB] = await Promise.all([signIn(environmentA, nodeA), signIn(environmentB, nodeB)]);
    await expectStatus(api(nodeB, sessionB, "PUT", "/cluster/node", { name: "Remote fixture node", url: nodeB.url }), 200, "rename remote node");

    const research = (await expectStatus(api<SnapshotResponse>(nodeA, sessionA, "POST", "/clusters", { name: "Research" }), 201, "create Research")).snapshot.body.clusterId;
    const invitation = await expectStatus(api<{ link: string }>(nodeA, sessionA, "POST", `/clusters/${research}/invitations`, { expectedEpoch: 1 }), 201, "invite");
    await expectStatus(api(nodeB, sessionB, "POST", "/clusters/join", { link: invitation.link, requestId: randomUUID() }), 201, "join Research");
    const operations = (await expectStatus(api<SnapshotResponse>(nodeA, sessionA, "POST", "/clusters", { name: "Operations" }), 201, "create Operations")).snapshot.body.clusterId;

    await sharedProject(nodeA, sessionA, "Research shared", research);
    await sharedProject(nodeA, sessionA, "Research extra one", research);
    await sharedProject(nodeA, sessionA, "Research extra two", research);
    await sharedProject(nodeA, sessionA, "Operations shared", operations);
    const privateId = await sharedProject(nodeA, sessionA, "Private only", null);
    const remoteId = await sharedProject(nodeB, sessionB, "Remote research", research);
    await waitFor(async () => {
      const { projects } = await expectStatus(api<{ projects: ProjectView[] }>(nodeA, sessionA, "GET", "/projects?syncStatus=false"), 200, "list projects");
      const remote = projects.find((project) => project.id === remoteId);
      return remote?.locallyOwned === false && remote.clusterIds?.includes(research) ? remote : undefined;
    }, "the remote project reaches this node through Research");

    browser = await launchChrome({ headless: process.env.HEADED !== "1" });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", serviceWorkers: "block" });
    page.setDefaultTimeout(15_000);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    // The conversation cluster filter follows where a conversation runs; "Short one" runs on the remote node.
    const internal = nodeA.projects.find((project) => project.name === "Internal Assistant")!;
    await page.route(new RegExp(`/api/projects/${internal.id}/sessions(\\?.*)?$`), async (route) => {
      if (route.request().method() !== "GET") { await route.continue(); return; }
      const response = await route.fetch();
      const body = await response.json() as { sessions: SessionSummary[] };
      for (const session of body.sessions) session.executionNodeId = session.title === "Short one" ? nodeB.nodeId : nodeA.nodeId;
      await route.fulfill({ response, json: body });
    });

    await page.goto(nodeA.url);
    await page.getByTestId("login-username-input").fill(environmentA.username);
    await page.getByTestId("login-password-input").fill(environmentA.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator(".project-card", { hasText: "Internal Assistant" }).first().waitFor();
    await openClusterSettings(page);

    // The map: one card per cluster with its faces and what flows each way, around this node.
    const items = page.getByTestId("cluster-item");
    assert.equal(await items.count(), 2);
    const researchItem = items.filter({ hasText: "Research" });
    assert.match(await researchItem.getByTestId("cluster-item-counts").innerText(), /you share 3 · ↓ you get 1/);
    assert.equal(await researchItem.locator(".cluster-avatar").count(), 2);
    assert.match(await items.filter({ hasText: "Operations" }).getByTestId("cluster-item-counts").innerText(), /you share 1 · ↓ you get 0/);

    await page.getByTestId("cluster-new-button").click();
    await page.getByTestId("cluster-create-name-input").fill("Cancelled cluster");
    await page.getByTestId("cluster-create-cancel").click();
    assert.equal(await page.getByTestId("cluster-create-name-input").isVisible(), false);
    assert.equal(await items.count(), 2);

    // The open cluster: its nodes, what this node gets, and one share list for everyone in it.
    await researchItem.click();
    const details = page.getByTestId("cluster-details");
    await details.getByRole("heading", { name: "Research" }).waitFor();
    assert.equal(await researchItem.getAttribute("aria-pressed"), "true");
    assert.equal(await page.getByTestId("cluster-strip").locator(".cluster-stop").count(), 2);
    const members = page.getByTestId("cluster-member");
    assert.equal(await members.count(), 2, "members are listed oldest first");
    assert.match(await members.nth(1).innerText(), /Remote fixture node/);
    assert.match(await members.first().innerText(), /You/);
    assert.match(await members.first().innerText(), /Manager/);
    await page.getByTestId(`cluster-member-make-twin-${nodeB.nodeId}`).waitFor();
    await page.getByTestId("cluster-tab-received").click();
    const receivedGroups = page.getByTestId("cluster-owner-group");
    assert.equal(await receivedGroups.count(), 1);
    assert.match(await receivedGroups.innerText(), /from Remote fixture node[\s\S]*Remote research/);
    assert.equal(await page.getByTestId("cluster-received").getByText("Operations shared").count(), 0, "another cluster's project does not leak in");
    const sharing = page.getByTestId("cluster-sharing");
    await page.getByTestId("cluster-tab-sharing").click();
    await page.getByTestId("sharing-save").waitFor();
    assert.match(await sharing.innerText(), /shared with every node in Research \(Remote fixture node\)/);
    assert.equal(await sharing.getByText("Remote research").count(), 0, "a received project cannot be reshared");
    assert.equal(await page.getByTestId(`sharing-project-${privateId}`).isChecked(), false);

    await items.filter({ hasText: "Operations" }).click();
    await details.getByRole("heading", { name: "Operations" }).waitFor();
    assert.equal(await members.count(), 1);
    await page.getByTestId("cluster-tab-received").click();
    await page.getByTestId("cluster-received").getByText("No projects shared with you in Operations.", { exact: true }).waitFor();

    // Fuzzy search finds a node by a few of its letters and opens its cluster.
    const search = page.getByTestId("cluster-search-input");
    await search.fill("rmt fxtr");
    await details.getByRole("heading", { name: "Research" }).waitFor();
    assert.equal(await items.count(), 1);
    assert.match(await page.getByTestId("cluster-search-status").innerText(), /1 cluster · 1 node match/);
    assert.match(await items.first().innerText(), /matches Remote fixture node/);
    assert.equal(await members.filter({ hasText: "Remote fixture node" }).getAttribute("data-match"), "true");
    await search.fill("oprtns");
    assert.deepEqual(await items.locator("strong").allInnerTexts(), ["Operations"]);
    await search.fill("zzzz");
    await page.getByTestId("cluster-list-no-match").waitFor();
    await search.press("Escape");
    assert.equal(await search.inputValue(), "");
    assert.equal(await items.count(), 2);

    // Keyboard: a cluster row is a button.
    await items.filter({ hasText: "Research" }).focus();
    await page.keyboard.press("Enter");
    await details.getByRole("heading", { name: "Research" }).waitFor();
    await page.getByTestId("cluster-tab-sharing").click();
    await sharing.getByText("You share with Research").waitFor();
    await page.getByTestId("sharing-save").waitFor();

    // Sharing is saved for the whole cluster.
    await page.getByTestId("sharing-project-search").fill("prvt");
    assert.equal(await page.getByTestId("sharing-project-list").locator(".checkbox-row:visible").count(), 1);
    await page.getByTestId(`sharing-project-${privateId}`).check();
    await page.getByTestId("sharing-save").click();
    await page.getByTestId("confirm-cancel-button").click();
    assert.deepEqual((await expectStatus(api<{ shares: unknown[] }>(nodeA, sessionA, "GET", `/sharing/project/${privateId}`), 200, "policy")).shares, [], "cancel saves nothing");
    await page.getByTestId("sharing-save").click();
    await page.getByTestId("confirm-accept-button").click();
    await waitFor(async () => (await api<{ shares: Array<{ clusterId: string }> }>(nodeA, sessionA, "GET", `/sharing/project/${privateId}`)).body.shares.some((share) => share.clusterId === research) || undefined, "private project is shared with Research");
    await page.waitForFunction(() => /you share 4/.test(document.querySelector('[data-testid="cluster-item"][aria-pressed="true"]')?.textContent || ""));

    // The cluster panel precedes the machine and browser settings, and fits a phone.
    const order = await page.getByTestId("settingsPanel-cluster").evaluate((panel) => {
      const list = panel.querySelector("#clusterCanvas")!, machine = panel.querySelector("#clusterNodeNameInput")!, browserSelect = panel.querySelector("#settingsBrowserClusterDefaults")!;
      return Boolean(list.compareDocumentPosition(machine) & Node.DOCUMENT_POSITION_FOLLOWING) && Boolean(machine.compareDocumentPosition(browserSelect) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    assert.equal(order, true);
    const canvas = page.getByTestId("cluster-canvas");
    assert.equal(await canvas.evaluate((element) => getComputedStyle(element).display), "block", "a wide screen draws the map");
    assert.equal(await canvas.locator(".cluster-map-wires line").count(), 2, "one wire to each cluster");

    // This machine opens from the middle of the map.
    await page.getByTestId("cluster-map-local").click();
    await page.getByTestId("cluster-machine-section").getByText("Discoverable URL").waitFor();
    assert.equal(await page.getByTestId("cluster-detail-pane").isVisible(), false);
    await items.filter({ hasText: "Research" }).click();
    await details.getByRole("heading", { name: "Research" }).waitFor();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, "no horizontal overflow on a phone");
    assert.equal(await canvas.evaluate((element) => getComputedStyle(element).display), "grid", "a phone lists the map's nodes as cards");
    const [mapBox, inspectorBox] = await Promise.all([canvas.boundingBox(), page.getByTestId("cluster-inspector").boundingBox()]);
    assert.ok(mapBox && inspectorBox && inspectorBox.y >= mapBox.y + mapBox.height, "the inspector stacks below the map on a phone");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByTestId("settings-cancel-button").click();
    await page.getByTestId("settings-dialog").waitFor({ state: "hidden" });

    // Project filter: clusters combine, and "Only on this node" means owned here and shared nowhere.
    const projectFilter = multiSelect(page, "project-cluster-filter");
    await projectFilter.root.waitFor();
    assert.deepEqual(await projectFilter.labels(), ["Only on this node", "Operations", "Research"]);
    const cards = page.locator("#projectList .project-card");
    const names = async () => (await cards.locator("strong").allInnerTexts()).map((text) => text.trim()).sort();
    await projectFilter.choose("Research");
    await page.waitForFunction(() => document.querySelectorAll("#projectList .project-card").length === 5);
    assert.deepEqual(await names(), ["Private only", "Remote research", "Research extra one", "Research extra two", "Research shared"]);
    await projectFilter.toggle("Operations");
    await page.waitForFunction(() => document.querySelectorAll("#projectList .project-card").length === 6);
    assert.equal(await projectFilter.trigger.innerText(), "Operations, Research");
    await projectFilter.choose("Only on this node");
    assert.deepEqual(await names(), ["Infra Scripts", "Internal Assistant", "Joint Bob"]);
    await projectFilter.choose();
    assert.equal(await cards.count(), 9);

    // Conversation filter: where the agent runs.
    await cards.filter({ hasText: "Internal Assistant" }).first().click();
    const sessionsList = page.locator("#sessionList .session-card");
    await sessionsList.first().waitFor();
    const total = await sessionsList.count();
    const conversationFilter = multiSelect(page, "conversation-cluster-filter");
    assert.deepEqual(await conversationFilter.labels(), ["This node", "Operations", "Research"]);
    await conversationFilter.choose("Research");
    assert.equal(await sessionsList.count(), 1);
    assert.match(await sessionsList.first().innerText(), /Short one/);
    assert.equal(await page.locator('[data-filter-count="all"]').textContent(), "1", "status counts follow the cluster filter");
    await conversationFilter.choose("This node");
    assert.equal(await sessionsList.count(), total - 1);
    await conversationFilter.choose("This node", "Research");
    assert.equal(await sessionsList.count(), total);
    await conversationFilter.choose("Operations");
    await page.locator("#sessionList").getByText("No matching conversations.", { exact: true }).waitFor();
    await conversationFilter.choose();
    assert.equal(await sessionsList.count(), total);
    assert.deepEqual(pageErrors, []);
  } finally {
    if (browser) await browser.close();
    await Promise.allSettled(servers.map((server) => stopDevNode(server)));
    await Promise.allSettled(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
});
