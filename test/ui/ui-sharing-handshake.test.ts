import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type Page } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment } from "../dev-nodes.js";

async function openSharing(page: Page, environment: DevEnvironment) {
  await page.goto(environment.nodes[0].url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByText("Internal Assistant", { exact: true }).waitFor();
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-cluster").click();
  await page.getByTestId("sharing-mode-selected").waitFor({ timeout: 5000 });
}

test("real nodes save selections and require invitation acceptance before Twins", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-sharing-pair-"));
  const a = await seedDevEnvironment(path.join(root, "a"), 1), b = await seedDevEnvironment(path.join(root, "b"), 1);
  const servers: Awaited<ReturnType<typeof startDevNode>>[] = [];
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    servers.push(await startDevNode(a, a.nodes[0]));
    servers.push(await startDevNode(b, b.nodes[0]));
    browser = await launchChrome({ headless: true });
    const sa = await signIn(a, a.nodes[0]), sb = await signIn(b, b.nodes[0]);
    const cluster = await api<{ snapshot: { body: { clusterId: string } } }>(a.nodes[0], sa, "POST", "/clusters", { name: "Home" });
    assert.equal(cluster.status, 201); const id = cluster.body.snapshot.body.clusterId;
    const invitation = await api<{ link: string }>(a.nodes[0], sa, "POST", `/clusters/${id}/invitations`, { expectedEpoch: 1 });
    assert.equal(invitation.status, 201);
    assert.equal((await api(b.nodes[0], sb, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() })).status, 201);
    const ca = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
    const cb = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
    const pa = await ca.newPage(), pb = await cb.newPage();
    await openSharing(pa, a); await openSharing(pb, b);
    const project = a.nodes[0].projects[0].id;
    await pa.getByTestId(`sharing-project-${project}`).check();
    await pa.getByTestId("sharing-save").click(); await pa.getByTestId("confirm-accept-button").click();
    await pa.getByTestId("sharing-status").getByText("Selection saved", { exact: false }).waitFor();
    const selection = await api<{ projectIds: string[] }>(a.nodes[0], sa, "GET", `/clusters/${id}/sharing`);
    assert.equal(selection.status, 200); assert.deepEqual(selection.body.projectIds, [project]);
    await pa.getByTestId("sharing-mode-twins").click(); await pa.getByTestId("twin-invite").click();
    await pa.getByTestId("confirm-cancel-button").click();
    assert.equal((await api<{ relationships: object[] }>(a.nodes[0], sa, "GET", "/twins")).body.relationships.length, 0);
    await pa.getByTestId("twin-invite").click(); await pa.getByTestId("confirm-accept-button").click();
    await pa.waitForFunction(() => (document.querySelector('[data-testid="twin-link"]') as HTMLInputElement).value.length > 0);
    const link = await pa.getByTestId("twin-link").inputValue();
    assert.equal(await pa.getByTestId("cluster-sharing").getByText("Up to date", { exact: false }).count(), 0);
    await pb.getByTestId("sharing-mode-twins").click(); await pb.getByTestId("twin-accept-link").fill(link);
    await pb.getByTestId("twin-accept").click(); await pb.getByTestId("confirm-cancel-button").click();
    assert.equal((await api<{ relationships: object[] }>(b.nodes[0], sb, "GET", "/twins")).body.relationships.length, 0);
    await pb.getByTestId("twin-accept").click();
    const accepted = pb.waitForResponse(response => response.url().endsWith("/api/twins/accept"));
    await pb.getByTestId("confirm-accept-button").click(); assert.equal((await accepted).status(), 201);
    for (const [environment, session] of [[a, sa], [b, sb]] as const) {
      const twins = await api<{ relationships: Array<{ status: string }> }>(environment.nodes[0], session, "GET", "/twins");
      assert.equal(twins.body.relationships[0].status, "active");
    }
    await pb.getByTestId("twin-sharing-status").waitFor();
    assert.equal(await pb.getByRole("button", { name: /Complete sharing/i }).count(), 0, "acceptance must start sharing without a completion action");
    await pa.getByTestId("twin-sharing-status").waitFor({ timeout: 15000 });
    for (const [environment, session, page, peer] of [[a, sa, pa, b.nodes[0]], [b, sb, pb, a.nodes[0]]] as const) {
      const twins = await api<{ relationships: Array<{ relationshipId: string }> }>(environment.nodes[0], session, "GET", "/twins");
      const sharing = await api<{ initialized: boolean; projectCount: number }>(environment.nodes[0], session, "GET", `/twins/${twins.body.relationships[0].relationshipId}/sharing`);
      assert.equal(sharing.body.initialized, true, "acceptance initializes durable sharing on both nodes");
      assert.ok(sharing.body.projectCount > 0, "acceptance registers existing projects without another click");
      assert.equal(await page.getByTestId("twin-enable-sharing").count(), 0);
      assert.equal(await page.getByTestId(`cluster-member-twin-${peer.nodeId}`).innerText(), "Twin");
    }
    await pa.getByTestId("sharing-mode-selected").click(); await pa.getByTestId("confirm-accept-button").click();
    await pa.getByTestId("sharing-save").waitFor();
    const revoked = await api<{ relationships: Array<{ status: string }> }>(a.nodes[0], sa, "GET", "/twins");
    assert.equal(revoked.body.relationships[0].status, "revoked");
  } finally { await browser?.close(); await Promise.all(servers.map(stopDevNode)); await rm(root, { recursive: true, force: true }); }
});
