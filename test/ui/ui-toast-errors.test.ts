import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Browser, Locator } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

async function visibleOnTop(locator: Locator) {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  });
}

test("learning failures are red corner alerts, stack without overlap, and persist until dismissed", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-toast-errors-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  let browser: Browser | undefined;
  try {
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.getByText("Internal Assistant", { exact: true }).click();
    const row = page.locator("#sessionList .list-row").filter({ has: page.locator("strong", { hasText: "Short one" }) }).first();
    await row.locator("button").first().click();
    await page.locator("#sessionTitle").filter({ hasText: "Short one" }).waitFor();
    await page.route("**/api/projects/*/sessions/done", (route) => route.fulfill({ json: { ok: true, feedbackError: "Learning service unavailable" } }));
    await page.setViewportSize({ width: 720, height: 900 });
    await page.getByTestId("chat-more-button").click();
    await page.getByTestId("chat-done-button").click();
    await page.getByTestId("conversation-feedback-good").check();
    await page.getByTestId("conversation-feedback-submit").click();
    const failure = page.locator(".toast", { hasText: "Conversation is done, but learning failed" });
    await failure.waitFor();
    assert.match(await failure.getAttribute("class") ?? "", /toast-error/, "learning failure must be an error, not a neutral success notice");
    assert.equal(await failure.getAttribute("role"), "alert");
    await page.evaluate(`import("/app/shell.js").then(({ toast }) => { toast("Saved successfully", 30000); toast.error("Second failure"); toast.error("Second failure"); })`);
    const second = page.locator(".toast", { hasText: "Second failure" });
    assert.equal(await second.count(), 1, "identical errors are deduplicated");
    const success = page.locator(".toast", { hasText: "Saved successfully" });
    assert.equal(await success.getAttribute("role"), "status", "success is not an assertive error");
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      const colors = await failure.evaluate((element) => ({ background: getComputedStyle(element).backgroundColor, text: getComputedStyle(element).color }));
      assert.equal(colors.background, "rgb(185, 28, 28)", "errors use a solid red background in both themes");
      assert.equal(colors.text, "rgb(255, 255, 255)");
      assert.notEqual(await success.evaluate((element) => getComputedStyle(element).backgroundColor), colors.background);
    }
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const boxes = await page.locator(".toast").evaluateAll((nodes) => nodes.map((node) => {
        const box = node.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      }));
      for (const box of boxes) {
        assert.ok(box.left >= 0 && box.right <= width && width - box.right <= 24, JSON.stringify(box));
        assert.ok(box.top >= 0 && box.bottom <= 900, JSON.stringify(box));
      }
      for (let index = 1; index < boxes.length; index++) assert.ok(boxes[index].top >= boxes[index - 1].bottom, "notifications must not overlap");
      assert.ok(await visibleOnTop(failure));
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => {
      for (const id of ["toast-outer-dialog", "toast-inner-dialog"]) {
        const dialog = document.createElement("dialog");
        dialog.id = id;
        dialog.innerHTML = '<input aria-label="Fixture field">';
        document.body.append(dialog);
        dialog.showModal();
      }
    });
    assert.ok(await visibleOnTop(failure), "existing errors stay above newly opened nested dialogs");
    assert.equal(await failure.evaluate((element) => element.closest("dialog")?.id), "toast-inner-dialog");
    await page.keyboard.press("Escape");
    await page.locator("#toast-inner-dialog").waitFor({ state: "hidden" });
    assert.ok(await visibleOnTop(failure), "closing the inner dialog does not hide the error");
    await page.keyboard.press("Escape");
    await page.locator("#toast-outer-dialog").waitFor({ state: "hidden" });
    assert.ok(await visibleOnTop(failure), "closing both dialogs leaves the error visible");
    await page.clock.install();
    await page.evaluate(`import("/app/shell.js").then(({ toast }) => { toast.error("Persistent failure"); toast("Temporary success"); })`);
    await page.clock.fastForward(60_000);
    assert.equal(await page.locator(".toast", { hasText: "Temporary success" }).count(), 0);
    const persistent = page.locator(".toast", { hasText: "Persistent failure" });
    assert.ok(await persistent.isVisible(), "errors wait for acknowledgement rather than disappearing");
    await persistent.getByTestId("toast-close-button").click();
    assert.equal(await persistent.count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
