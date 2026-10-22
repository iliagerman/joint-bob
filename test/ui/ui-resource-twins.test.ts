import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";

test("selected twin shows its skills, counts and working activation controls", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resource-twin-ui-"));
  const servers: Awaited<ReturnType<typeof startDevNode>>[] = [];
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 2), [a, b] = environment.nodes;
    const folder = path.join(environment.home, "JointBob/.agent-resources/shared/skills/twin-fixture");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "SKILL.md"), "---\nname: twin-fixture\ndescription: Twin management fixture\n---\n");
    for (const node of environment.nodes) servers.push(await startDevNode(environment, node));
    await pairTwinNodes(environment);
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(a.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.getByText("Internal Assistant", { exact: true }).waitFor();
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-resources").click();
    await page.getByTestId("resources-skill-row").filter({ hasText: "twin-fixture" }).waitFor();
    let rejectTwinLoad = true;
    await page.route(`${a.url}/api/resources/activation?nodeId=${b.nodeId}`, async (route) => {
      if (rejectTwinLoad) await route.fulfill({ status: 503, json: { error: "Fixture twin unavailable" } });
      else await route.continue();
    });
    await page.getByTestId("resources-node-select").selectOption(b.nodeId);
    await page.getByTestId("resources-status").getByText("Fixture twin unavailable").waitFor();
    assert.equal(await page.getByTestId("resources-auto-activate").isDisabled(), true, "failed twin load must not expose the previous node's default as editable");
    rejectTwinLoad = false;
    await page.getByTestId("resources-refresh-button").click();
    const row = page.getByTestId("resources-skill-row").filter({ hasText: "twin-fixture" });
    await row.getByTestId("resources-activation-toggle").first().waitFor({ timeout: 15_000 });
    await page.getByTestId("resources-harness-select").selectOption("pi");
    const toggle = row.getByTestId("resources-activation-toggle");
    await toggle.uncheck();
    await page.waitForFunction(() => document.querySelector("#resourcesStatus")?.textContent?.includes("twin-fixture disabled"));
    const session = await signIn(environment, b);
    const result = await api<{ nodes: Array<{ inventory: { skills: Array<{ name: string; activation: { pi: { preference: boolean } } }> } }> }>(b, session, "GET", "/resources/inventory");
    assert.equal(result.body.nodes[0].inventory.skills.find((skill) => skill.name === "twin-fixture")?.activation.pi.preference, false);
    await page.getByTestId("resources-state-select").selectOption("enabled");
    await page.getByTestId("resources-search-input").fill("twin-fixture");
    await page.getByTestId("resources-list").getByText(/No skills match/).waitFor();
    assert.match(await page.getByTestId("resources-tab-skills").innerText(), /\(0\)/, "count follows selected node and filters");
    await page.getByTestId("resources-clear-filters").click();
    await row.waitFor();
    assert.match(await page.getByTestId("resources-summary").innerText(), /twin/i);
    // Resolve an old node's save only after the newly selected node is ready.
    for (const fail of [false, true]) {
      let release!: () => void, intercepted!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const seen = new Promise<void>((resolve) => { intercepted = resolve; });
      const handler = async (route: import("playwright-core").Route) => {
        if (route.request().method() !== "PUT") { await route.continue(); return; }
        intercepted();
        await gate;
        await route.fulfill({ status: fail ? 503 : 200, json: fail ? { error: "Old save failed" } : { autoActivateSharedSkills: false } });
      };
      await page.route(`${a.url}/api/resources/activation`, handler);
      const auto = page.getByTestId("resources-auto-activate");
      await auto.uncheck();
      await seen;
      // Synthetic shared-only peer is only a UI fixture, never an authorized target.
      await page.route(`${a.url}/api/resources/inventory?*`, async (route) => {
        const response = await route.fetch(), body = await response.json();
        body.nodes.push({ node: { id: "shared-fixture", name: "Shared fixture", local: false, online: true }, inventory: body.nodes[0].inventory });
        await route.fulfill({ response, json: body });
      });
      await page.getByTestId("resources-refresh-button").click();
      await page.getByTestId("resources-node-select").locator('option[value="shared-fixture"]').waitFor({ state: "attached" });
      await page.getByTestId("resources-node-select").selectOption("shared-fixture");
      await page.waitForFunction(() => document.querySelector("#resourcesSummary")?.textContent?.includes("Shared fixture"));
      const wasChecked = await auto.isChecked();
      release();
      await page.waitForResponse((response) => response.url() === `${a.url}/api/resources/activation` && response.request().method() === "PUT");
      // Drain the API promise and its render, not a timer.
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await auto.isDisabled(), true, "late save must not re-enable shared-only node control");
      assert.equal(await auto.isChecked(), wasChecked, "late failure must not flip newly selected node's default");
      await page.unroute(`${a.url}/api/resources/activation`, handler);
      await page.unroute(`${a.url}/api/resources/inventory?*`);
      await page.getByTestId("resources-node-select").selectOption(b.nodeId);
      await row.getByTestId("resources-activation-toggle").first().waitFor();
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    for (const server of servers) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
