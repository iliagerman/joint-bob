import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";

test("project menu opens scoped webhooks without Settings and restores the global editor", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-project-webhooks-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  const browser = await launchChrome({ headless: true });
  try {
    const session = await signIn(environment, node);
    const projects = (await api<{ projects: Array<{ id: string; name: string }> }>(node, session, "GET", "/projects")).body.projects;
    const project = projects.find(item => item.name === "Joint Bob")!;
    const other = projects.find(item => item.name === "Internal Assistant")!;
    for (const target of [project, other]) {
      const created = await api(node, session, "POST", "/webhooks", { name: `${target.name} hook`, target: { kind: "project", projectId: target.id } });
      assert.equal(created.status, 201);
    }
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator(`[data-project-id="${project.id}"]`).getByTestId("project-menu-button").click();
    await page.getByTestId("project-webhooks-button").click();
    await page.getByTestId("project-webhooks-dialog").waitFor();
    await page.getByTestId("webhooks-list").getByText("Joint Bob hook", { exact: true }).waitFor();
    assert.equal(await page.getByTestId("settings-dialog").isVisible(), false);
    assert.equal(await page.getByTestId("webhooks-list").getByText("Internal Assistant hook", { exact: true }).count(), 0);
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 700 }]) {
      await page.setViewportSize(viewport);
      const bounds = await page.getByTestId("project-webhooks-dialog").boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width);
      assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= viewport.height);
    }
    await page.getByTestId("webhooks-open-button").click();
    await page.getByTestId("webhooks-tab-memory").click();
    await page.getByTestId("webhook-memory-enabled-toggle").waitFor();
    await page.getByTestId("webhooks-back-button").click();
    await page.getByTestId("webhooks-new-button").click();
    await page.getByTestId("webhooks-form").waitFor();
    assert.equal(await page.getByTestId("webhooks-project-select").inputValue(), project.id);
    assert.equal(await page.getByTestId("webhooks-project-select").isDisabled(), true);
    await page.getByTestId("webhooks-name-input").fill("Created from project");
    await page.getByTestId("webhooks-save-button").click();
    await page.getByTestId("webhooks-reveal").waitFor();
    const hooks = (await api<{ webhooks: Array<{ name: string; target: { projectId: string } }> }>(node, session, "GET", "/webhooks")).body.webhooks;
    assert.equal(hooks.find(hook => hook.name === "Created from project")!.target.projectId, project.id);
    await page.getByTestId("project-webhooks-close").click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-webhooks").click();
    await page.getByTestId("webhooks-list").getByText("Internal Assistant hook", { exact: true }).waitFor();
    await page.getByTestId("webhooks-new-button").click();
    await page.getByTestId("webhooks-form").waitFor();
    assert.equal(await page.getByTestId("webhooks-project-select").isDisabled(), false);
  } finally {
    await browser.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
