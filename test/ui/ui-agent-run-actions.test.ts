import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

test("conversation actions stay inside the card when sub-agent tasks extend the row", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-agent-actions-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    await page.route("**/api/projects/*/sessions", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.sessions[0].agentRuns = [{ tasks: Array.from({ length: 5 }, (_, index) => ({
        name: `Worker ${index}`, role: "developer", status: "running", task: "Check deployment",
      })) }];
      await route.fulfill({ response, json: body });
    });
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.getByText("Internal Assistant", { exact: true }).click();
    const found = page.locator("#sessionList .list-row").filter({ has: page.getByTestId("agent-run-task") }).first();
    await found.waitFor();
    // Collapsing drops the task lines, so the row is addressed by its own path from here on.
    const row = page.locator(`#sessionList .list-row[data-session-path="${await found.getAttribute("data-session-path")}"]`);
    assert.equal(await row.getByTestId("agent-run-task").count(), 5);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const geometry = await row.evaluate((element) => {
      const card = element.querySelector(".session-card")!.getBoundingClientRect();
      const actions = [...element.querySelectorAll(".row-action-button")].map((action) => {
        const box = action.getBoundingClientRect();
        return { name: action.getAttribute("aria-label"), top: box.top, bottom: box.bottom };
      });
      return { rowHeight: element.getBoundingClientRect().height, cardHeight: card.height, top: card.top, bottom: card.bottom, actions };
    });
    assert.ok(geometry.rowHeight > geometry.cardHeight + 50, "task list must extend well below the card");
    assert.ok(geometry.actions.length >= 2, "pin and menu actions must be present");
    for (const action of geometry.actions) {
      assert.ok(action.top >= geometry.top && action.bottom <= geometry.bottom,
        `${action.name} spans ${action.top}..${action.bottom}, outside card ${geometry.top}..${geometry.bottom}`);
    }

    // A conversation fanning out to five sub-agents buries the rows under it, so the
    // run lines fold away behind their summary and come back on the same button.
    const toggle = row.getByTestId("agent-run-toggle");
    assert.equal(await toggle.textContent(), "▾ 5 sub-agent steps · 5 running");
    await toggle.click();
    await row.getByTestId("agent-run-task").first().waitFor({ state: "detached" });
    assert.equal(await row.getByTestId("agent-run-task").count(), 0, "collapsing hides every sub-agent line");
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    const collapsedHeight = await row.evaluate((element) => element.getBoundingClientRect().height);
    assert.ok(collapsedHeight < geometry.rowHeight - 50, `collapsed row ${collapsedHeight} must be far shorter than ${geometry.rowHeight}`);

    await toggle.click();
    await row.getByTestId("agent-run-task").first().waitFor();
    assert.equal(await row.getByTestId("agent-run-task").count(), 5, "reopening brings every sub-agent line back");
  } finally {
    await browser.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
