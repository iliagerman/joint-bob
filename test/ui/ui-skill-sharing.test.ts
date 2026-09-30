import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";

test("Skills tab shares single and bulk skills, pages long lists, and removes managed skills on desktop and mobile", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-sharing-ui-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1), node = environment.nodes[0];
    const source = path.join(environment.home, "JointBob/.agent-resources/shared/skills/portable");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "---\nname: portable\ndescription: UI fixture skill\n---\n");
    for (let index = 1; index <= 24; index += 1) {
      const name = `bulk-${String(index).padStart(2, "0")}`;
      const folder = path.join(environment.home, "JointBob/.agent-resources/shared/skills", name);
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: Bulk fixture ${index}\n---\n`);
    }
    server = await startDevNode(environment, node);
    const session = await signIn(environment, node);
    const clusterIds: Record<string, string> = {};
    for (const name of ["Home", "Work"]) {
      const created = await api<{ snapshot: { body: { clusterId: string } } }>(node, session, "POST", "/clusters", { name });
      assert.equal(created.status, 201);
      clusterIds[name] = created.body.snapshot.body.clusterId;
    }
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
    const pageLabel = page.getByTestId("resources-list-pager").getByTestId("resources-page-label");
    await pageLabel.getByText(/^1–20 of \d+$/).waitFor();
    await page.getByTestId("resources-list-pager").getByTestId("resources-page-next").click();
    await pageLabel.getByText(/^21–/).waitFor();
    assert.equal(await page.getByTestId("resources-skill-row").count() <= 20, true, "a page holds at most 20 skills");

    await page.getByTestId("resources-search-input").fill("bulk-0");
    await page.getByTestId("resources-select-all").click();
    const bar = page.getByTestId("resources-share-bar");
    await bar.getByTestId("resources-selected-count").getByText("9 skills selected").waitFor();
    await bar.getByTestId("resources-share-open").click();
    await bar.getByText("No other nodes in your clusters yet.").waitFor();
    await bar.getByLabel("Work", { exact: true }).check();
    await bar.getByTestId("resources-share-apply").click();
    await page.getByTestId("confirm-accept-button").click();
    await page.getByTestId("resources-status").getByText(/Shared 9 skills with Work \(cluster\)/).waitFor();
    const bulk = await api<{ skills: Array<{ name: string; clusterIds: string[] }> }>(node, session, "GET", "/resources/skills/sharing");
    for (let index = 1; index <= 9; index += 1) assert.deepEqual(bulk.body.skills.find((skill) => skill.name === `bulk-0${index}`)?.clusterIds, [clusterIds.Work]);
    assert.deepEqual(bulk.body.skills.find((skill) => skill.name === "bulk-10")?.clusterIds, []);
    await page.getByTestId("resources-skill-row").filter({ hasText: "bulk-01" }).getByText("Shared with Work (cluster)", { exact: true }).waitFor();

    await page.getByTestId("resources-search-input").fill("portable");
    const row = page.getByTestId("resources-skill-row").filter({ hasText: "UI fixture skill" });
    await row.getByText("Local only · Share", { exact: true }).click();
    await row.getByLabel("Home", { exact: true }).check();
    await row.getByTestId("skill-sharing-save").click();
    await page.getByTestId("confirm-accept-button").click();
    await row.getByText("Shared with Home (cluster)", { exact: true }).waitFor();
    await row.getByText("Shared with Home (cluster)", { exact: true }).click();
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
