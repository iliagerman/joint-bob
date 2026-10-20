import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

test("Resources omits receiving-node status even when a peer is failing", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resource-peer-status-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    for (let index = 0; index < 30; index++) {
      const name = `fixture-${String(index).padStart(2, "0")}`;
      const folder = path.join(environment.home, "JointBob/.agent-resources/shared/skills", name);
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: Synthetic test skill\n---\n`);
    }
    server = await startDevNode(environment, node);
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    await page.route(`${node.url}/api/resources/skills/sharing`, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.peerStatus = Array.from({ length: 4 }, (_, index) => ({
        ownerNodeId: `fixture-peer-${index}`, ownerName: `Fixture peer ${index}`,
        lastSuccess: "2026-01-01T00:00:00.000Z", error: index === 0 ? "Synthetic sync failure" : null,
      }));
      await route.fulfill({ response, json: body });
    });
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.getByText("Internal Assistant", { exact: true }).waitFor();
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-resources").click();
    await page.getByTestId("resources-list-pager").getByTestId("resources-page-label").waitFor();
    assert.equal(await page.locator(".resources-peer-status").count(), 0, "receiving-node section removed");
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.ok(await page.getByTestId("resources-skill-row").count() < 30, "precondition: paginated list");
    await page.getByTestId("resources-refresh-button").click();
    await page.getByTestId("resources-skill-row").first().waitFor();
    assert.equal(await page.locator(".resources-peer-status").count(), 0, "refresh does not restore receiving-node status");
  } finally {
    if (browser) await browser.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
