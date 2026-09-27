import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type Page } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "../dev-nodes.js";

async function openCluster(page: Page, environment: DevEnvironment) {
  await page.goto(environment.nodes[0].url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByText("Internal Assistant", { exact: true }).waitFor();
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-cluster").click();
  await page.getByTestId("cluster-member").first().waitFor();
}

async function relationships(node: SeededNode, session: SignedIn): Promise<Array<{ relationshipId: string; status: string }>> {
  return (await api<{ relationships: Array<{ relationshipId: string; status: string }> }>(node, session, "GET", "/twins")).body.relationships;
}

test("cluster members pair as twins by request and acceptance, and unpair from the node row", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-twin-requests-"));
  const a = await seedDevEnvironment(path.join(root, "a"), 1), b = await seedDevEnvironment(path.join(root, "b"), 1);
  const servers: Awaited<ReturnType<typeof startDevNode>>[] = [];
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    servers.push(await startDevNode(a, a.nodes[0]), await startDevNode(b, b.nodes[0]));
    const [nodeA, nodeB] = [a.nodes[0], b.nodes[0]];
    const sa = await signIn(a, nodeA), sb = await signIn(b, nodeB);
    const cluster = await api<{ snapshot: { body: { clusterId: string } } }>(nodeA, sa, "POST", "/clusters", { name: "Home" });
    assert.equal(cluster.status, 201);
    const invitation = await api<{ link: string }>(nodeA, sa, "POST", `/clusters/${cluster.body.snapshot.body.clusterId}/invitations`, { expectedEpoch: 1 });
    assert.equal((await api(nodeB, sb, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() })).status, 201);
    browser = await launchChrome({ headless: process.env.HEADED !== "1" });
    const pa = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" })).newPage();
    const pb = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" })).newPage();
    for (const page of [pa, pb]) page.setDefaultTimeout(15_000);
    await openCluster(pa, a); await openCluster(pb, b);

    // Asking needs consent; cancelling sends nothing.
    await pa.getByTestId(`cluster-member-make-twin-${nodeB.nodeId}`).click();
    await pa.getByTestId("confirm-cancel-button").click();
    assert.deepEqual((await api<{ requests: unknown[] }>(nodeB, sb, "GET", "/twins/requests")).body.requests, []);
    await pa.getByTestId(`cluster-member-make-twin-${nodeB.nodeId}`).click();
    await pa.getByTestId("confirm-accept-button").click();
    await pa.getByTestId(`cluster-member-requested-${nodeB.nodeId}`).waitFor();

    // The other node sees the request without reloading, and can decline it.
    const banner = pb.getByTestId("cluster-twin-request");
    await banner.waitFor({ timeout: 10_000 });
    assert.match(await banner.innerText(), /asks to be twins with this node \(via Home\)/);
    await pb.getByTestId(`cluster-member-accept-${nodeA.nodeId}`).waitFor();
    await banner.getByTestId("cluster-twin-request-decline").click();
    await banner.waitFor({ state: "detached" });
    await pa.getByTestId(`cluster-member-make-twin-${nodeB.nodeId}`).waitFor({ timeout: 10_000 });
    assert.deepEqual(await relationships(nodeA, sa), [], "a declined request pairs nothing");

    // Ask again; accepting needs consent too.
    await pa.getByTestId(`cluster-member-make-twin-${nodeB.nodeId}`).click();
    await pa.getByTestId("confirm-accept-button").click();
    await banner.waitFor({ timeout: 10_000 });
    await banner.getByTestId("cluster-twin-request-accept").click();
    await pb.getByTestId("confirm-cancel-button").click();
    assert.deepEqual(await relationships(nodeB, sb), []);
    await banner.getByTestId("cluster-twin-request-accept").click();
    const accepted = pb.waitForResponse((response) => /\/api\/twins\/requests\/[^/]+\/accept$/.test(response.url()));
    await pb.getByTestId("confirm-accept-button").click();
    assert.equal((await accepted).status(), 201);
    for (const [node, session] of [[nodeA, sa], [nodeB, sb]] as const) {
      assert.deepEqual((await relationships(node, session)).map((item) => item.status), ["active"]);
    }
    await pb.getByTestId(`cluster-member-twin-${nodeA.nodeId}`).waitFor();
    await pa.getByTestId(`cluster-member-twin-${nodeB.nodeId}`).waitFor({ timeout: 10_000 });
    // The twins section lists the new twin with its connection and sync state.
    const twinRow = pa.getByTestId("cluster-nodes").getByTestId("cluster-node-row").filter({ hasText: nodeB.name });
    await twinRow.getByTestId("twin-sharing-status").waitFor({ timeout: 10_000 });
    const strip = pa.getByTestId("cluster-strip");
    assert.equal(await strip.locator('.cluster-wire[data-twin="true"]').count(), 1, "the strip joins the twins with a dashed wire");
    const [{ relationshipId }] = await relationships(nodeA, sa);
    const sharing = await api<{ initialized: boolean }>(nodeA, sa, "GET", `/twins/${relationshipId}/sharing`);
    assert.equal(sharing.body.initialized, true, "accepting starts sharing without another step");

    // Unpairing from the node row asks first, then revokes.
    await pa.getByTestId(`cluster-member-unpair-${nodeB.nodeId}`).click();
    await pa.getByTestId("confirm-cancel-button").click();
    assert.equal((await relationships(nodeA, sa))[0].status, "active");
    await pa.getByTestId(`cluster-member-unpair-${nodeB.nodeId}`).click();
    await pa.getByTestId("confirm-accept-button").click();
    await pa.getByTestId(`cluster-member-make-twin-${nodeB.nodeId}`).waitFor();
    assert.equal((await relationships(nodeA, sa))[0].status, "revoked");

    // Pairing by link still works for nodes outside any cluster, and its fields are labelled.
    await pa.getByTestId("cluster-twin-link").locator("summary").click();
    await pa.getByTestId("twin-invite").click();
    await pa.getByTestId("confirm-cancel-button").click();
    assert.equal(await pa.getByTestId("twin-link").inputValue(), "");
    await pa.getByTestId("twin-invite").click();
    await pa.getByTestId("confirm-accept-button").click();
    await pa.waitForFunction(() => (document.querySelector('[data-testid="twin-link"]') as HTMLInputElement).value.startsWith("http"));
    for (const id of ["twin-link", "twin-accept-link", "cluster-invite-link-input", "cluster-join-link-input"]) {
      const field = pa.getByTestId(id);
      assert.ok(await field.getAttribute("name"), `${id} has a form name`);
      assert.equal(await field.getAttribute("autocomplete"), "off");
      assert.equal(await field.getAttribute("spellcheck"), "false");
      assert.ok(await field.evaluate((element: HTMLInputElement) => element.labels?.length), `${id} has a label`);
    }
  } finally { await browser?.close(); await Promise.all(servers.map(stopDevNode)); await rm(root, { recursive: true, force: true }); }
});
