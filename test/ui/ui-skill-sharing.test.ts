import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";

test("Skills tab selects clusters and removes managed skills on desktop and mobile", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-sharing-ui-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1), node = environment.nodes[0];
    const source = path.join(environment.home, "JointBob/.agent-resources/shared/skills/portable");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "---\nname: portable\ndescription: UI fixture skill\n---\n");
    server = await startDevNode(environment, node);
    const session = await signIn(environment, node);
    for (const name of ["Home", "Work"]) assert.equal((await api(node, session, "POST", "/clusters", { name })).status, 201);
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
    await page.locator(".session-card", { hasText: "Thread-Based Agent Builder" }).first().click();
    await page.getByTestId("chat-resources-button").click();
    const row = page.getByTestId("resources-skill-row").filter({ hasText: "UI fixture skill" });
    await row.getByText("Local only · Share", { exact: true }).click();
    await row.getByLabel("Home", { exact: true }).check();
    await row.getByTestId("skill-sharing-save").click();
    await page.getByTestId("confirm-accept-button").click();
    await row.getByText("Shared with Home", { exact: true }).waitFor();
    await row.getByText("Shared with Home", { exact: true }).click();
    assert.equal(await row.getByLabel("Home", { exact: true }).isChecked(), true);
    assert.equal(await row.getByLabel("Work", { exact: true }).isChecked(), false);
    await row.getByLabel("Home", { exact: true }).uncheck();
    await row.getByTestId("skill-sharing-save").click();
    await row.getByText("Local only · Share", { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 900 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const box = await page.getByTestId("resources-dialog").boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390);
    await row.getByTestId("skill-remove").click();
    await page.getByTestId("confirm-accept-button").click();
    await page.getByTestId("resources-status").getByText(/Removed\. Backup:/).waitFor();
    assert.equal(await row.count(), 0);
    const state = await api<{ skills: Array<{ name: string }> }>(node, session, "GET", "/resources/skills/sharing");
    assert.equal(state.body.skills.some((skill) => skill.name === "portable"), false);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
