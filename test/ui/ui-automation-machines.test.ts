import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";

test("webhooks and schedules expose creation machines and transfer controls", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "automation-machines-"));
  const servers: ChildProcess[] = [];
  const browser = await launchChrome({ headless: true });
  try {
    const env = await seedDevEnvironment(root, 2);
    const [a, b] = env.nodes;
    for (const node of env.nodes) servers.push(await startDevNode(env, node));
    const auth = await signIn(env, a);
    await pairTwinNodes(env);
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on("pageerror", error => console.error("Browser error:", error.message));
    await page.goto(a.url);
    await page.getByTestId("login-username-input").fill(env.username);
    await page.getByTestId("login-password-input").fill(env.password);
    await page.getByTestId("login-submit-button").click();
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-webhooks").click();
    await page.getByTestId("webhooks-new-button").click();
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('#webhooksForm')!.hidden || document.querySelector('#webhooksStatus')?.getAttribute('data-state') === 'error');
    assert.equal(await page.locator('#webhooksStatus').getAttribute('data-state'), '', await page.locator('#webhooksStatus').textContent() || '');
    await page.getByTestId("webhooks-name-input").fill("Remote machine hook");
    await page.getByTestId("webhooks-machine-select").selectOption(b.nodeId);
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-testid="webhooks-save-button"]')!.disabled);
    assert.equal(await page.getByTestId("webhooks-name-input").inputValue(), "Remote machine hook");
    await page.getByTestId("webhooks-save-button").click();
    await page.getByTestId("webhooks-reveal").waitFor();
    await page.getByTestId("webhooks-machine-select").selectOption(a.nodeId);
    await page.getByTestId("webhooks-transfer-button").click();
    await page.getByTestId("webhooks-transfer-button").click();
    await page.waitForFunction(() => document.querySelector('[data-testid="webhooks-reveal"]')?.textContent?.includes("Transferred"));
    const hooks = await api<{ webhooks: Array<{ name: string }> }>(a, auth, "GET", "/webhooks");
    assert.equal(hooks.body.webhooks[0].name, "Remote machine hook");
    await page.evaluate(async projectId => {
      document.querySelector<HTMLDialogElement>("#settingsDialog")!.close();
      const module = await import("/app/cron.js");
      await module.openScheduledTasks(projectId);
    }, a.projects[0].id);
    await page.getByTestId("cron-new").click();
    await page.getByTestId("cron-owner").selectOption(b.nodeId);
    assert.equal(await page.getByTestId("cron-owner").inputValue(), b.nodeId);
    // Seed a schedule to exercise transfer without coupling this test to every schedule field.
    const created = await api(a, auth, "POST", "/cron", { nodeId: b.nodeId, command: { action: "create", input: { name: "Move schedule", projectId: a.projects[0].id, prompt: "Report", engine: "pi", sessionId: null, ownerNodeId: b.nodeId, enabled: false, schedule: { frequency: "daily", hour: 9, minute: 0, weekday: 1, timezone: "UTC" } } } });
    assert.equal(created.status, 200);
    await page.evaluate(async projectId => {
      const module = await import("/app/cron.js");
      await module.openScheduledTasks(projectId);
    }, a.projects[0].id);
    await page.getByTestId("cron-transfer").click();
    await page.getByTestId("cron-owner").selectOption(a.nodeId);
    await page.getByTestId("cron-save").click();
    await page.getByTestId("cron-task").waitFor();
    const tasks = await api<{ tasks: Array<{ ownerNodeId: string }> }>(a, auth, "GET", `/projects/${a.projects[0].id}/cron`);
    assert.equal(tasks.body.tasks[0].ownerNodeId, a.nodeId);
  } finally {
    await browser.close();
    await Promise.all(servers.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
