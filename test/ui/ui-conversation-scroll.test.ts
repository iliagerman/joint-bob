import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

test("desktop conversations scroll with the page, not inside the column", async () => {
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
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const geometry = await page.evaluate(() => {
      const list = document.querySelector<HTMLElement>("#sessionList")!;
      return {
        overflow: getComputedStyle(list).overflowY,
        scrollHeight: list.scrollHeight,
        height: list.clientHeight,
        pageHeight: document.documentElement.scrollHeight,
        viewportHeight: innerHeight,
      };
    });
    assert.ok(geometry.scrollHeight > geometry.viewportHeight, "fixture must overflow the viewport");
    assert.equal(geometry.overflow, "visible", "conversation list has no inner scrollbar");
    assert.equal(geometry.scrollHeight, geometry.height, "conversation rows are not clipped");
    assert.ok(geometry.pageHeight > geometry.viewportHeight, "page can scroll to the last row");

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const positions = await page.evaluate(() => ({
      pageScroll: window.scrollY,
      lastRow: [...document.querySelectorAll("#sessionList .session-card")].at(-1)?.getBoundingClientRect().bottom,
      chatTop: document.querySelector("#chatPanel")!.getBoundingClientRect().top,
    }));
    assert.ok(positions.pageScroll > 0, "page scrolls");
    assert.ok(positions.lastRow !== undefined && positions.lastRow <= 900, `last row stays reachable: ${JSON.stringify(positions)}`);
    assert.equal(positions.chatTop, 10, "chat column stays in place");

    await page.setViewportSize({ width: 390, height: 800 });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator("#sessionList").evaluate((list) => getComputedStyle(list).overflowY), "auto", "mobile retains its own list scrolling");
  } finally {
    if (browser) await browser.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
