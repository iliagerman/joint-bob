import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type Browser, type Page } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { multiSelect } from "./multi-select.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";

interface PopoverFit { trigger: number; left: number; right: number; laneLeft: number; laneRight: number; lane: string; sideways: string[] }

/** Where an open filter list sits against the lane that clips or scrolls it, and which ancestors it pushed sideways. */
async function popoverFit(page: Page, testid: string): Promise<PopoverFit> {
  return page.getByTestId(testid).evaluate((root) => {
    const popover = root.querySelector<HTMLElement>(".searchable-select-popover")!;
    const sideways: string[] = [];
    let lane: Element = document.documentElement;
    for (let element = root.parentElement; element; element = element.parentElement) {
      if (element.scrollWidth > element.clientWidth + 1) sideways.push(element.id || element.className || element.tagName);
      if (lane === document.documentElement && getComputedStyle(element).overflowX !== "visible") lane = element;
    }
    const box = popover.getBoundingClientRect();
    const laneBox = lane.getBoundingClientRect();
    return { trigger: root.getBoundingClientRect().width, left: box.left, right: box.right, laneLeft: laneBox.left, laneRight: laneBox.right, lane: lane.id || lane.className || lane.tagName, sideways };
  });
}

test("list filter dropdowns open inside their lane without scrolling it sideways", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-filter-popover-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  let browser: Browser | undefined;
  try {
    const auth = await signIn(environment, node);
    // The cluster filters only appear once this node belongs to a cluster.
    assert.equal((await api(node, auth, "POST", "/clusters", { name: "Research" })).status, 201);
    const project = node.projects.find((entry) => entry.name === "Internal Assistant")!;
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    const widths = [1440, 1100, 900];
    async function expectFit(testids: string[]): Promise<void> {
      for (const width of widths) {
        await page.setViewportSize({ width, height: 900 });
        for (const testid of testids) {
          const filter = multiSelect(page, testid);
          await filter.root.waitFor();
          await filter.open();
          const fit = await popoverFit(page, testid);
          await filter.close();
          const where = `${testid} at ${width}px: ${JSON.stringify(fit)}`;
          assert.ok(fit.right - fit.left >= 220 - 1, `the list is wide enough to read, ${where}`);
          assert.ok(fit.left >= fit.laneLeft - 1 && fit.right <= fit.laneRight + 1, `the list stays inside its lane, ${where}`);
          assert.deepEqual(fit.sideways, [], `opening the list scrolls nothing sideways, ${where}`);
        }
      }
    }
    await expectFit(["project-cluster-filter"]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator(".project-card", { hasText: project.name }).first().click();
    await page.locator("#sessionList .session-card").first().waitFor();
    await expectFit(["conversation-classification-filter", "conversation-cluster-filter"]);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
