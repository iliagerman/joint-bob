import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

test("conversations scroll vertically inside the column while the page stays fixed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-conversation-scroll-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    server = await startDevNode(environment, node);
    browser = await launchChrome({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
    const page = await context.newPage();
    await page.goto(node.url, { waitUntil: "domcontentloaded" });
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
    await page.locator("#sessionList .session-card").first().waitFor();
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const geometry = await page.evaluate(() => {
        const list = document.querySelector<HTMLElement>("#sessionList")!;
        list.scrollTop = list.scrollHeight;
        return {
          overflow: getComputedStyle(list).overflowY,
          scrollHeight: list.scrollHeight,
          height: list.clientHeight,
          scrollTop: list.scrollTop,
          scrollWidth: list.scrollWidth,
          width: list.clientWidth,
          lastRow: [...list.querySelectorAll(".session-card")].at(-1)!.getBoundingClientRect().bottom,
          listBottom: list.getBoundingClientRect().bottom,
          pageHeight: document.documentElement.scrollHeight,
          viewportHeight: innerHeight,
        };
      });
      assert.equal(geometry.overflow, "auto", `at ${width}px, retain vertical list scrolling`);
      assert.ok(geometry.scrollHeight > geometry.height && geometry.scrollTop > 0, `at ${width}px, fixture must scroll inside the list`);
      assert.equal(geometry.scrollWidth, geometry.width, `at ${width}px, list must not scroll horizontally`);
      assert.ok(geometry.lastRow <= geometry.listBottom, `at ${width}px, last conversation stays reachable`);
      assert.ok(geometry.pageHeight <= geometry.viewportHeight, `at ${width}px, page stays within the viewport`);
    }
  } finally {
    if (browser) await browser.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
