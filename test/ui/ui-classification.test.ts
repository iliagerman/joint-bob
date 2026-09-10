import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium, type Browser } from "playwright-core";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

test("new Pi and Claude conversations keep predefined and free-text classifications", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-labels-ui-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? "chrome", headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-labels").click();
    await page.getByTestId("settings-conversation-labels").fill("Research\nBug\nFeature\nPOC\nSupport");
    await page.getByTestId("settings-save-button").click();
    await page.locator("#settingsDialog").waitFor({ state: "hidden" });
    await page.reload();
    await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
    for (const [engine, selection, label] of [["pi", "Support", "Support"], ["claude", "__other__", "Investigation <custom>"]]) {
      await page.getByTestId(engine === "pi" ? "session-create-button" : "session-create-claude-button").click();
      await page.getByTestId("new-session-name-input").fill(`${engine} classified conversation`);
      const select = page.getByTestId("new-session-classification-select");
      await select.selectOption(selection);
      assert.deepEqual(await select.locator("option").allTextContents(), ["Unclassified", "Research", "Bug", "Feature", "POC", "Support", "Other…"]);
      if (selection === "__other__") {
        await page.getByTestId("new-session-name-start-button").click();
        assert.equal(await page.getByTestId("new-session-name-dialog").isVisible(), true, "Other requires text");
        await page.getByTestId("new-session-classification-other").fill(label);
      }
      if (engine === "pi") {
        await page.route("**/sessions/classification", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Label save unavailable" }) }));
        await page.getByTestId("new-session-name-start-button").click();
        await page.getByText("Label save unavailable", { exact: true }).waitFor();
        assert.equal(await page.getByTestId("new-session-name-dialog").isVisible(), true, "failed save keeps the draft open");
        assert.equal(await select.inputValue(), "Support");
        await page.unroute("**/sessions/classification");
      }
      const titleSaved = page.waitForResponse((response) => response.url().endsWith("/sessions/title") && response.ok());
      await page.getByTestId("new-session-name-start-button").click();
      const badge = page.locator("#sessionList").getByTestId("session-classification").filter({ hasText: label });
      await titleSaved;
      await badge.waitFor();
      assert.equal(await badge.textContent(), label);
      await page.reload();
      await page.getByTestId("chat-message-input").and(page.locator(":enabled")).waitFor();
      await badge.waitFor();
      assert.equal(await badge.textContent(), label);
    }
    await page.keyboard.press("Meta+Shift+V");
    await page.getByTestId("canvas-add-button").click();
    await page.getByTestId("canvas-classification-select").selectOption("Support");
    const classified = page.waitForResponse((response) => response.url().endsWith("/sessions/classification") && response.ok());
    await page.getByTestId("canvas-start-conversation-pi").click();
    const saved = await classified;
    const payload = saved.request().postDataJSON();
    assert.equal(payload.classification, "Support");
    await page.waitForFunction(async ({ projectId, sessionId }) => {
      const response = await fetch(`/api/projects/${projectId}/sessions`);
      const { sessions } = await response.json();
      return sessions.some((session: { id: string; classification?: string }) => session.id === sessionId && session.classification === "Support");
    }, { projectId: node.projects[0].id, sessionId: payload.sessionId });
    await page.keyboard.press("Meta+Shift+V");
    await page.getByTestId("session-create-button").click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("new-session-classification-select").selectOption("__other__");
    await page.getByTestId("new-session-classification-other").fill("Mobile label");
    const box = await page.getByTestId("new-session-classification-other").boundingBox();
    assert.ok(box && box.width > 150 && box.x >= 0 && box.x + box.width <= 390, "classification fits mobile dialog");
    await page.getByTestId("new-session-name-cancel-button").click();
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
