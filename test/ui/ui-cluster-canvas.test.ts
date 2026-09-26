import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type Browser } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import {
  api,
  seedDevEnvironment,
  signIn,
  startDevNode,
  stopDevNode,
  type DevEnvironment,
  type SeededNode,
  type SignedIn,
} from "../dev-nodes.js";

interface SnapshotResponse {
  snapshot: { body: { clusterId: string } };
}
interface InvitationResponse { link: string }
interface ProjectResponse { project: { id: string } }
interface ClustersResponse {
  mode: string;
  clusters: Array<{ id: string; name: string }>;
}

async function expectStatus<T>(request: Promise<{ status: number; body: T }>, status: number, label: string): Promise<T> {
  const response = await request;
  assert.equal(response.status, status, `${label} returned ${response.status}: ${JSON.stringify(response.body)}`);
  return response.body;
}

async function createProject(node: SeededNode, session: SignedIn, name: string): Promise<string> {
  const body = await expectStatus(
    api<ProjectResponse>(node, session, "POST", "/projects", { name, type: "personal", synced: false }),
    201,
    `create ${name}`,
  );
  return body.project.id;
}

test("cluster dropdown scopes membership details and supports create cancellation, keyboard and mobile", { timeout: 180_000 }, async () => {
  const roots: string[] = [];
  const servers: ChildProcess[] = [];
  let browser: Browser | undefined;

  try {
    const rootA = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-cluster-canvas-a-"));
    roots.push(rootA);
    const rootB = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-cluster-canvas-b-"));
    roots.push(rootB);
    const [environmentA, environmentB]: [DevEnvironment, DevEnvironment] = await Promise.all([
      seedDevEnvironment(rootA, 1),
      seedDevEnvironment(rootB, 1),
    ]);
    const nodeA = environmentA.nodes[0];
    const nodeB = environmentB.nodes[0];
    servers.push(await startDevNode(environmentA, nodeA));
    servers.push(await startDevNode(environmentB, nodeB));
    const [sessionA, sessionB] = await Promise.all([
      signIn(environmentA, nodeA),
      signIn(environmentB, nodeB),
    ]);

    await expectStatus(
      api(nodeB, sessionB, "PUT", "/cluster/node", { name: "Remote fixture node", url: nodeB.url }),
      200,
      "rename remote fixture node",
    );
    const researchCluster = await expectStatus(
      api<SnapshotResponse>(nodeA, sessionA, "POST", "/clusters", { name: "Research" }),
      201,
      "create Research cluster",
    );
    const researchId = researchCluster.snapshot.body.clusterId;
    const invitation = await expectStatus(
      api<InvitationResponse>(nodeA, sessionA, "POST", `/clusters/${researchId}/invitations`, { expectedEpoch: 1 }),
      201,
      "invite remote fixture node",
    );
    await expectStatus(
      api(nodeB, sessionB, "POST", "/clusters/join", { link: invitation.link, requestId: randomUUID() }),
      201,
      "join Research cluster",
    );
    const operationsCluster = await expectStatus(
      api<SnapshotResponse>(nodeA, sessionA, "POST", "/clusters", { name: "Operations" }),
      201,
      "create Operations cluster",
    );
    const operationsId = operationsCluster.snapshot.body.clusterId;

    const researchProjectId = await createProject(nodeA, sessionA, "Research shared");
    const operationsProjectId = await createProject(nodeA, sessionA, "Operations shared");
    await createProject(nodeA, sessionA, "Private only");
    await expectStatus(
      api(nodeA, sessionA, "PUT", `/sharing/project/${researchProjectId}`, {
        expectedGeneration: 1,
        shares: [{ clusterId: researchId, projectId: null }],
      }),
      200,
      "share Research project",
    );
    await expectStatus(
      api(nodeA, sessionA, "PUT", `/sharing/project/${operationsProjectId}`, {
        expectedGeneration: 1,
        shares: [{ clusterId: operationsId, projectId: null }],
      }),
      200,
      "share Operations project",
    );

    const memberships = await expectStatus(
      api<ClustersResponse>(nodeA, sessionA, "GET", "/clusters"),
      200,
      "list fixture memberships",
    );
    assert.equal(memberships.mode, "selective");
    assert.deepEqual(
      memberships.clusters.map(({ id, name }) => ({ id, name })).sort((left, right) => left.name.localeCompare(right.name)),
      [{ id: operationsId, name: "Operations" }, { id: researchId, name: "Research" }],
      "browser fixture has exactly the two independent memberships",
    );

    browser = await launchChrome({ headless: process.env.HEADED !== "1" });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
    const page = await context.newPage();
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));

    await page.goto(nodeA.url, { waitUntil: "domcontentloaded" });
    await page.locator("#loginDialog[open]").waitFor({ timeout: 30_000 });
    await page.getByTestId("login-username-input").fill(environmentA.username);
    await page.getByTestId("login-password-input").fill(environmentA.password);
    await page.getByTestId("login-submit-button").click();
    await page.getByText("Internal Assistant", { exact: true }).waitFor({ timeout: 30_000 });
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-cluster").click();

    const canvas = page.getByTestId("cluster-canvas");
    await canvas.waitFor({ state: "visible", timeout: 15_000 });
    const selector = page.getByRole("combobox", { name: "Cluster", exact: true });
    await selector.waitFor({ timeout: 3000 });
    assert.equal(await selector.evaluate(element => element.tagName), "SELECT");
    const clusterButtons = selector.locator("option");
    assert.equal(await clusterButtons.count(), 2);
    await page.getByTestId("cluster-new-button").click();
    await page.getByTestId("cluster-create-name-input").fill("Cancelled cluster");
    await page.getByTestId("cluster-create-cancel").click();
    assert.equal(await page.getByTestId("cluster-create-name-input").isVisible(), false);
    assert.deepEqual(await selector.locator("option").allTextContents().then(names => names.sort()), ["Operations", "Research"]);

    const details = page.getByTestId("cluster-details");
    assert.equal(await page.getByTestId("cluster-technical").getAttribute("open"), null);
    const order = await page.getByTestId("settingsPanel-cluster").evaluate(panel => {
      const selector = panel.querySelector("#clusterSelector")!;
      const machine = panel.querySelector("#clusterNodeNameInput")!;
      const browser = panel.querySelector("#settingsBrowserExecutor")!;
      return Boolean(selector.compareDocumentPosition(machine) & Node.DOCUMENT_POSITION_FOLLOWING)
        && Boolean(machine.compareDocumentPosition(browser) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    assert.equal(order, true, "cluster management precedes machine and browser defaults");
    await selector.selectOption(researchId);
    await details.getByRole("heading", { name: "Research" }).waitFor();
    await assertDetails(details, ["Remote fixture node", "Research shared"], ["Operations shared", "Private only"]);
    assert.equal(await selector.inputValue(), researchId);

    await selector.selectOption(operationsId);
    await details.getByRole("heading", { name: "Operations" }).waitFor();
    await assertDetails(details, ["Operations shared"], ["Remote fixture node", "Research shared", "Private only"]);
    assert.equal(await selector.inputValue(), operationsId);

    await selector.focus();
    await selector.press("Home");
    await selector.press("r");
    await selector.press("Enter");
    await details.getByRole("heading", { name: "Research" }).waitFor();
    await assertDetails(details, ["Remote fixture node", "Research shared"], ["Operations shared", "Private only"]);
    assert.equal(await page.getByTestId("settingsPanel-cluster").getByTestId("cluster-invite-project-input").count(), 0);
    await assertTextAbsent(page.getByTestId("settingsPanel-cluster"), "Replace cluster");

    await page.setViewportSize({ width: 390, height: 844 });
    await selector.scrollIntoViewIfNeeded();
    await selector.selectOption(operationsId);
    await details.getByRole("heading", { name: "Operations" }).waitFor();
    await assertDetails(details, ["Operations shared"], ["Remote fixture node", "Research shared", "Private only"]);
    const hasPageOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    assert.equal(hasPageOverflow, false, "settings page has no horizontal overflow at mobile width");
    assert.deepEqual(pageErrors.map((error) => error.message), [], "page emitted no errors");
  } finally {
    if (browser) await browser.close();
    await Promise.allSettled(servers.map((server) => stopDevNode(server)));
    await Promise.allSettled(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
});

async function assertDetails(details: import("playwright-core").Locator, present: string[], absent: string[]): Promise<void> {
  for (const text of present) await details.getByText(text, { exact: true }).waitFor();
  for (const text of absent) assert.equal(await details.getByText(text, { exact: true }).count(), 0, `${text} does not leak into selected cluster`);
}

async function assertTextAbsent(locator: import("playwright-core").Locator, text: string): Promise<void> {
  assert.equal(await locator.getByText(text, { exact: false }).count(), 0, `${text} is absent from selective cluster UI`);
}
