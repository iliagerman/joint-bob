import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium, type Browser } from "playwright-core";
import type { SessionSummary } from "../../src/types.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";

test("classification filters combine with search and status, include custom labels, and reset between projects", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-label-filter-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  let browser: Browser | undefined;
  try {
    const auth = await signIn(environment, node);
    const project = node.projects.find((entry) => entry.name === "Internal Assistant")!;
    const sessions = (await api<{ sessions: SessionSummary[] }>(node, auth, "GET", `/projects/${project.id}/sessions`)).body.sessions;
    for (const [title, classification] of [["Thread-Based Agent Builder", "Bug"], ["[Claude] Makor deployment information", "Bug"], ["Short one", "Investigation <custom>"], ["Flow Runner Tool Evaluation", "unclassified"]]) {
      const session = sessions.find((entry) => entry.title === title);
      assert.ok(session, `Missing seeded conversation ${title}`);
      assert.equal((await api(node, auth, "PUT", `/projects/${project.id}/sessions/classification`, { sessionId: session.id, engine: session.harnessId, classification })).status, 200);
    }
    browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? "chrome", headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator(".project-card", { hasText: project.name }).first().click();
    const filter = page.getByTestId("conversation-classification-filter");
    await filter.waitFor();
    await page.locator("#sessionList .session-card").first().waitFor();
    const rows = page.locator("#sessionList .session-card");
    assert.equal(await rows.count(), sessions.length);
    for (const label of ["All labels", "Unclassified", "Research", "Bug", "Feature", "POC", "Investigation <custom>", "unclassified"]) {
      assert.ok((await filter.locator("option").allTextContents()).includes(label), `Missing filter ${label}`);
    }
    await filter.selectOption("label:Bug");
    assert.equal(await rows.count(), 2);
    assert.equal(await page.locator('[data-filter-count="all"]').textContent(), "2", "status counts respect classification");
    await page.getByTestId("conversation-list-search-input").fill("thread-based");
    assert.equal(await rows.count(), 1);
    assert.match(await rows.first().innerText(), /Thread-Based Agent Builder/);
    await page.getByTestId("chats-filter-active-button").click();
    assert.equal(await rows.count(), 0, "status and classification filters intersect");
    await page.getByTestId("chats-filter-all-button").click();
    assert.equal(await filter.inputValue(), "label:Bug", "All statuses does not clear the classification filter");
    assert.equal(await rows.count(), 1);
    await filter.selectOption("unclassified");
    assert.equal(await rows.count(), 0, "search and Unclassified also intersect");
    await page.getByTestId("conversation-list-search-input").fill("");
    assert.equal(await rows.count(), sessions.length - 4);
    await filter.selectOption("label:unclassified");
    assert.equal(await rows.count(), 1, "a literal custom label cannot collide with Unclassified");
    assert.match(await rows.first().innerText(), /Flow Runner Tool Evaluation/);
    await filter.selectOption("label:Investigation <custom>");
    assert.equal(await rows.count(), 1);
    assert.match(await rows.first().innerText(), /Short one/);
    await filter.selectOption("label:Feature");
    assert.equal(await rows.count(), 0);
    await page.locator("#sessionList").getByText("No matching conversations.", { exact: true }).waitFor();

    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-labels").click();
    await page.getByTestId("settings-conversation-labels").fill("Research\nBug\nFeature\nPOC\nSupport");
    await page.getByTestId("settings-save-button").click();
    await page.locator("#settingsDialog").waitFor({ state: "hidden" });
    await filter.selectOption("label:Support");
    assert.equal(await rows.count(), 0, "new predefined labels are immediately filterable without conversations");
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-labels").click();
    await page.getByTestId("settings-conversation-labels").fill("Research\nBug\nFeature\nPOC");
    await page.getByTestId("settings-save-button").click();
    await page.locator("#settingsDialog").waitFor({ state: "hidden" });
    assert.equal(await filter.inputValue(), "label:Support", "removing a preset never hides the active filter");
    await filter.selectOption("");
    assert.equal((await filter.locator("option").allTextContents()).includes("Support"), false);
    assert.equal(await rows.count(), sessions.length);
    await filter.selectOption("label:Investigation <custom>");
    await page.locator(".project-card", { hasText: "Joint Bob" }).first().click();
    await rows.first().waitFor();
    assert.equal(await filter.inputValue(), "", "changing project resets classification filtering");
    assert.equal((await filter.locator("option").allTextContents()).includes("Investigation <custom>"), false, "custom labels come from the selected project");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const box = await filter.boundingBox();
    assert.ok(box && box.width > 150 && box.x >= 0 && box.x + box.width <= 390, "filter fits the mobile conversation panel");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
