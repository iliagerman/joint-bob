import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type Browser } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { multiSelect } from "./multi-select.js";
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
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Seeded conversations are all reviewed; two read as awaiting review so status chips have two statuses to combine.
    await page.route(new RegExp(`/api/projects/${project.id}/sessions(\\?.*)?$`), async (route) => {
      if (route.request().method() !== "GET") { await route.continue(); return; }
      const response = await route.fetch();
      const body = await response.json() as { sessions: SessionSummary[] };
      for (const session of body.sessions) if (["Short one", "Flow Runner Tool Evaluation"].includes(session.title)) session.reviewState = "needs_review";
      await route.fulfill({ response, json: body });
    });
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator(".project-card", { hasText: project.name }).first().click();
    const filter = multiSelect(page, "conversation-classification-filter");
    await filter.root.waitFor();
    await page.locator("#sessionList .session-card").first().waitFor();
    const rows = page.locator("#sessionList .session-card");
    assert.equal(await rows.count(), sessions.length);
    assert.equal(await filter.trigger.innerText(), "All labels");
    const labels = await filter.labels();
    for (const label of ["Unclassified", "Research", "Bug", "Feature", "POC", "Investigation <custom>", "unclassified"]) {
      assert.ok(labels.includes(label), `Missing filter ${label}`);
    }
    await filter.choose("Bug");
    assert.equal(await rows.count(), 2);
    assert.equal(await filter.trigger.innerText(), "Bug");
    assert.equal(await page.locator('[data-filter-count="all"]').textContent(), "2", "status counts respect classification");
    await page.getByTestId("conversation-list-search-input").fill("thread-based");
    assert.equal(await rows.count(), 1);
    assert.match(await rows.first().innerText(), /Thread-Based Agent Builder/);
    await page.getByTestId("chats-filter-active-button").click();
    assert.equal(await rows.count(), 0, "status and classification filters intersect");
    await page.getByTestId("chats-filter-all-button").click();
    assert.deepEqual(await filter.selected(), ["Bug"], "All statuses does not clear the classification filter");
    assert.equal(await rows.count(), 1);
    await filter.choose("Unclassified");
    assert.equal(await rows.count(), 0, "search and Unclassified also intersect");
    await page.getByTestId("conversation-list-search-input").fill("");
    assert.equal(await rows.count(), sessions.length - 4);
    await filter.choose("unclassified");
    assert.equal(await rows.count(), 1, "a literal custom label cannot collide with Unclassified");
    assert.match(await rows.first().innerText(), /Flow Runner Tool Evaluation/);
    // Several labels at once show conversations carrying any of them.
    await filter.choose("unclassified", "Investigation <custom>", "Bug");
    assert.equal(await rows.count(), 4);
    assert.match(await filter.trigger.innerText(), /^Labels: 3 selected$/);
    await filter.choose("Investigation <custom>");
    assert.equal(await rows.count(), 1);
    assert.match(await rows.first().innerText(), /Short one/);
    await filter.choose("Feature");
    assert.equal(await rows.count(), 0);
    await page.locator("#sessionList").getByText("No matching conversations.", { exact: true }).waitFor();

    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-labels").click();
    await page.getByTestId("settings-conversation-labels").fill("Research\nBug\nFeature\nPOC\nSupport");
    await page.getByTestId("settings-save-button").click();
    await page.locator("#settingsDialog").waitFor({ state: "hidden" });
    await filter.choose("Support");
    assert.equal(await rows.count(), 0, "new predefined labels are immediately filterable without conversations");
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-labels").click();
    await page.getByTestId("settings-conversation-labels").fill("Research\nBug\nFeature\nPOC");
    await page.getByTestId("settings-save-button").click();
    await page.locator("#settingsDialog").waitFor({ state: "hidden" });
    assert.deepEqual(await filter.selected(), ["Support"], "removing a preset never hides the active filter");
    await filter.choose();
    assert.equal((await filter.labels()).includes("Support"), false);
    assert.equal(await rows.count(), sessions.length);

    // Status chips combine: two chosen statuses show both, a chip toggles off, and All clears them.
    const count = async (filter: string) => Number(await page.locator(`[data-filter-count="${filter}"]`).textContent());
    const [first, second] = ["review", "done"];
    assert.equal(await count(first), 2);
    assert.ok(await count(second) > 0);
    const chip = (status: string) => page.getByTestId(`chats-filter-${status}-button`);
    await chip(first).click();
    assert.equal(await rows.count(), await count(first));
    await chip(second).click();
    assert.equal(await rows.count(), await count(first) + await count(second), `${first} and ${second} together`);
    assert.equal(await chip(first).getAttribute("aria-pressed"), "true");
    assert.equal(await chip(second).getAttribute("aria-pressed"), "true");
    assert.equal(await chip("all").getAttribute("aria-pressed"), "false");
    await chip(first).click();
    assert.equal(await rows.count(), await count(second), "a chosen chip toggles off");
    await chip("all").click();
    assert.equal(await rows.count(), sessions.length);
    assert.equal(await chip(second).getAttribute("aria-pressed"), "false");
    assert.equal(await chip("all").getAttribute("aria-pressed"), "true");

    await filter.choose("Investigation <custom>");
    await page.locator(".project-card", { hasText: "Joint Bob" }).first().click();
    await rows.first().waitFor();
    assert.equal(await filter.trigger.innerText(), "All labels", "changing project resets classification filtering");
    assert.equal((await filter.labels()).includes("Investigation <custom>"), false, "custom labels come from the selected project");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const box = await filter.root.boundingBox();
    assert.ok(box && box.width > 150 && box.x >= 0 && box.x + box.width <= 390, "filter fits the mobile conversation panel");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
