import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

test("resource settings explicitly publish and reload skills", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-ui-")); let server: ChildProcess | undefined; let browser;
  try {
    const environment = await seedDevEnvironment(root, 1); const node = environment.nodes[0];
    const source = path.join(root, "external/visible"); await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "---\nname: visible\ndescription: first\n---\n");
    server = await startDevNode(environment, node); browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? "chrome", headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error" && !message.text().includes("400 (Bad Request)")) errors.push(message.text()); });
    await page.goto(node.url); await page.getByTestId("login-username-input").fill(environment.username); await page.getByTestId("login-password-input").fill(environment.password); await page.getByTestId("login-submit-button").click();
    await page.getByText("Internal Assistant", { exact: true }).waitFor(); await page.getByTestId("settings-open-button").click(); await page.getByTestId("settings-tab-resources").click();
    await page.getByTestId("settings-resource-skills-paths").fill(source);
    await page.getByTestId("settings-sync-skills-button").click(); await page.getByTestId("confirm-cancel-button").click();
    await assert.rejects(readFile(path.join(environment.home, "JointBob/.agent-resources/shared/skills/visible/SKILL.md")));
    await page.getByTestId("settings-sync-skills-button").click(); await page.getByTestId("confirm-accept-button").click(); await page.getByTestId("settings-skills-status").getByText(/Published for Syncthing/).waitFor();
    const sharedManifest = path.join(environment.home, "JointBob/.agent-resources/shared/skills/visible/SKILL.md");
    assert.match(await readFile(sharedManifest, "utf8"), /first/);
    await writeFile(path.join(source, "SKILL.md"), "---\nname: visible\ndescription: second\n---\n");
    await page.getByTestId("settings-sync-skills-button").click();
    const [updated] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/settings/skills/sync") && response.status() === 200),
      page.getByTestId("confirm-accept-button").click(),
    ]);
    assert.equal(updated.status(), 200);
    await page.getByTestId("settings-skills-status").getByText(/Published 1/).waitFor();
    assert.match(await readFile(sharedManifest, "utf8"), /second/);
    await page.getByTestId("settings-resource-skills-paths").fill(path.join(root, "missing"));
    await page.getByTestId("settings-sync-skills-button").click();
    const [rejected] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/settings/skills/sync") && response.status() === 400),
      page.getByTestId("confirm-accept-button").click(),
    ]);
    assert.equal(rejected.status(), 400);
    await page.getByTestId("settings-skills-status").getByText(/ENOENT|missing/i).waitFor();
    assert.equal(await page.getByTestId("settings-sync-skills-button").isEnabled(), true);
    assert.equal(await page.getByTestId("settings-reload-skills-button").isEnabled(), true);
    await page.getByTestId("settings-reload-skills-button").click(); await page.getByTestId("settings-skills-status").getByText(/Claude loads changes on its next run/).waitFor();
    for (const width of [1440, 390]) { await page.setViewportSize({ width, height: 900 }); await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))); for (const id of ["settings-sync-skills-button", "settings-reload-skills-button"]) { const box = await page.getByTestId(id).boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= width); } }
    assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); if (server) await stopDevNode(server); await rm(root, { recursive: true, force: true }); }
});
