import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Browser } from "playwright-core";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";
import { launchChrome } from "./launch-chrome.js";

test("a selected workspace shows its twin-owned projects checked and counts them as shared", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ui-twin-workspace-sharing-"));
  const servers: Awaited<ReturnType<typeof startDevNode>>[] = [];
  let browser: Browser | undefined;
  try {
    const environment = await seedDevEnvironment(root, 2), [owner, twin] = environment.nodes;
    for (const node of environment.nodes) servers.push(await startDevNode(environment, node));
    const [ownerSession, twinSession] = await Promise.all(environment.nodes.map(node => signIn(environment, node)));
    await pairTwinNodes(environment);
    const created = await api<{ snapshot: { body: { clusterId: string } } }>(owner, ownerSession, "POST", "/clusters", { name: "Workspace fixture" });
    assert.equal(created.status, 201);
    const clusterId = created.body.snapshot.body.clusterId;
    const invitation = await api<{ link: string }>(owner, ownerSession, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
    assert.equal((await api(twin, twinSession, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() })).status, 201);
    const inventory = await api<{ projects: Array<{ id: string; workspaceId: string }>; workspaces: Array<{ id: string; label: string }> }>(twin, twinSession, "GET", `/clusters/${clusterId}/sharing`);
    const project = inventory.body.projects.find(project => project.id === owner.projects.find(item => item.name === "Internal Assistant")!.id)!;
    const workspaceProjects = inventory.body.projects.filter(item => item.workspaceId === project.workspaceId);
    const workspace = inventory.body.workspaces.find(item => item.id === project.workspaceId)!;

    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(twin.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator(".project-card").first().waitFor();
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-cluster").click();
    const cluster = page.getByTestId("cluster-item").filter({ hasText: "Workspace fixture" });
    await cluster.click();
    await page.getByTestId("cluster-tab-sharing").click();
    await page.getByTestId("sharing-save").waitFor();
    const workspaceCheckbox = page.getByTestId(`sharing-workspace-${project.workspaceId}`);
    await workspaceCheckbox.check();
    for (const item of workspaceProjects) {
      const checkbox = page.getByTestId(`sharing-project-${item.id}`);
      assert.equal(await checkbox.isChecked(), true, "workspace selection must check each inherited project immediately");
      assert.equal(await checkbox.isDisabled(), true, "unsharing an inherited project requires unchecking its workspace");
      assert.match(await checkbox.locator("..").innerText(), new RegExp(`via ${workspace.label}`));
    }
    assert.equal(await page.getByTestId("sharing-project-summary").innerText(), `Projects · ${workspaceProjects.length} of ${inventory.body.projects.length}`);
    await page.getByTestId("sharing-save").click();
    const saving = page.waitForResponse(response => response.url().endsWith(`/clusters/${clusterId}/sharing`) && response.request().method() === "PUT");
    await page.getByTestId("confirm-accept-button").click();
    const savedResponse = await saving;
    assert.equal(savedResponse.status(), 200, await savedResponse.text());
    await page.waitForFunction(count => document.querySelector('[data-testid="cluster-item-counts"]')?.textContent?.includes(`you share ${count} · ↓ you get 0`), workspaceProjects.length).catch(async error => {
      throw new Error(`${error.message}; counts=${await cluster.innerText()}; status=${await page.getByTestId("sharing-status").innerText()}; projects=${JSON.stringify((await api(twin, twinSession, "GET", "/projects?syncStatus=false")).body)}`);
    });
    assert.match(await page.getByTestId("cluster-tab-sharing").innerText(), new RegExp(String(workspaceProjects.length)));
    await page.getByTestId("sharing-save").waitFor();
    assert.equal(await page.getByTestId(`sharing-project-${project.id}`).isChecked(), true, "saved inheritance survives rerender");
    const saved = await api<{ projectIds: string[]; workspaceIds: string[] }>(twin, twinSession, "GET", `/clusters/${clusterId}/sharing`);
    assert.deepEqual(saved.body.projectIds, [], "inherited checks must not become explicit grants");
    assert.deepEqual(saved.body.workspaceIds, [project.workspaceId]);
    await page.getByTestId(`sharing-workspace-${project.workspaceId}`).uncheck();
    assert.equal(await page.getByTestId(`sharing-project-${project.id}`).isChecked(), false, "unchecking a workspace clears inherited checks");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await Promise.all(servers.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
