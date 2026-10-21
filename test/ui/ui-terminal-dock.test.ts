import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";

async function signIn(page: Page, url: string, username: string, password: string) {
  await page.goto(url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.getByTestId("login-username-input").fill(username);
  await page.getByTestId("login-password-input").fill(password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#loginDialog[open]").waitFor({ state: "hidden" });
  await page.locator(".project-card").first().waitFor({ state: "visible" });
}

async function openTerminal(page: Page) {
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card").first().click();
  const openButton = page.getByTestId("chat-open-terminal-button");
  await openButton.waitFor({ state: "visible" });
  await openButton.click();
  await page.locator('#terminalStatus[data-state="live"]').waitFor();
}

test("terminal docks below the workspace and can switch to a full-height right panel", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);
  await openTerminal(page);

  const panel = page.getByTestId("terminal-panel");
  assert.equal(await panel.isVisible(), true, "opening Terminal shows a docked panel");
  const bottom = await page.evaluate(() => {
    const panelRect = document.querySelector("#terminalPanel")!.getBoundingClientRect();
    const shellRect = document.querySelector(".shell")!.getBoundingClientRect();
    return { orientation: document.body.dataset.terminalOrientation, panelRect: { top: panelRect.top, bottom: panelRect.bottom, left: panelRect.left, right: panelRect.right }, shellRect: { bottom: shellRect.bottom, right: shellRect.right }, viewport: { width: innerWidth, height: innerHeight } };
  });
  assert.equal(bottom.orientation, "horizontal");
  assert.ok(bottom.panelRect.top >= bottom.shellRect.bottom - 1, "bottom terminal sits below the workspace panels");
  assert.equal(bottom.panelRect.left, 0, "bottom terminal spans from the left edge");
  assert.equal(bottom.panelRect.right, bottom.viewport.width, "bottom terminal spans the workspace width");
  assert.equal(bottom.panelRect.bottom, bottom.viewport.height, "bottom terminal reaches the bottom edge");

  const orientationSaved = page.waitForResponse((response) => response.url().endsWith("/api/preferences")
    && response.request().method() === "PUT"
    && response.request().postDataJSON()?.terminalDock?.orientation === "vertical");
  await page.getByTestId("terminal-orientation-vertical").click();
  await orientationSaved;
  const savedOrientation = await page.evaluate(async () => (await fetch("/api/preferences")).json());
  assert.equal(savedOrientation.terminalDock.orientation, "vertical", "orientation is saved as an account preference");
  const right = await page.evaluate(() => {
    const panelRect = document.querySelector("#terminalPanel")!.getBoundingClientRect();
    const shellRect = document.querySelector(".shell")!.getBoundingClientRect();
    return { orientation: document.body.dataset.terminalOrientation, panelRect: { top: panelRect.top, bottom: panelRect.bottom, left: panelRect.left, right: panelRect.right }, shellRect: { right: shellRect.right }, viewport: { width: innerWidth, height: innerHeight } };
  });
  assert.equal(right.orientation, "vertical");
  assert.equal(right.panelRect.top, 0, "right terminal starts at the top edge");
  assert.equal(right.panelRect.bottom, right.viewport.height, "right terminal uses full screen height");
  assert.equal(right.panelRect.right, right.viewport.width, "right terminal reaches the right edge");
  assert.ok(right.panelRect.left >= right.shellRect.right - 1, "right terminal sits beside the workspace panels");

  await page.getByTestId("terminal-close-button").click();
  assert.equal(await panel.isVisible(), false, "Close hides the docked terminal");
});

test("terminal dock preferences apply again when travelling preferences reload", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);
  await page.evaluate(async () => {
    const { api } = await import("/app/api.js");
    await api("/api/preferences", { method: "PUT", body: JSON.stringify({ terminalDock: { orientation: "vertical", horizontalSize: 360, verticalSize: 520 } }) });
    const { reloadTravellingPreferences } = await import("/app/roaming.js");
    await reloadTravellingPreferences();
  });
  assert.equal(await page.locator("body").getAttribute("data-terminal-orientation"), "vertical");
  assert.equal(await page.getByTestId("terminal-panel").getAttribute("data-orientation"), "vertical");
  assert.equal(await page.locator("body").evaluate((body) => getComputedStyle(body).getPropertyValue("--terminal-dock-size").trim()), "520px");
});

test("terminal orientation and divider size survive a page reload", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);
  await openTerminal(page);
  await page.getByTestId("terminal-orientation-vertical").click();

  const handle = page.getByTestId("terminal-resize-handle");
  const before = await page.getByTestId("terminal-panel").evaluate((panel) => panel.getBoundingClientRect().width);
  const handleBox = await handle.boundingBox();
  assert.ok(handleBox, "vertical dock exposes a resize handle");
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x - 90, handleBox.y + handleBox.height / 2);
  const sizeSaved = page.waitForResponse((response) => response.url().endsWith("/api/preferences")
    && response.request().method() === "PUT"
    && response.request().postDataJSON()?.terminalDock?.verticalSize > before);
  await page.mouse.up();
  await sizeSaved;
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const after = await page.getByTestId("terminal-panel").evaluate((panel) => panel.getBoundingClientRect().width);
  assert.ok(after > before + 50, `dragging the divider rightward grows the dock, from ${before}px to ${after}px`);
  const savedSize = await page.evaluate(async () => (await fetch("/api/preferences")).json());
  assert.equal(savedSize.terminalDock.verticalSize, after, "divider size is saved as an account preference");

  await page.reload();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().waitFor({ state: "visible" });
  await openTerminal(page);
  assert.equal(await page.locator("body").getAttribute("data-terminal-orientation"), "vertical");
  const restored = await page.getByTestId("terminal-panel").evaluate((panel) => panel.getBoundingClientRect().width);
  assert.ok(Math.abs(restored - after) < 2, `divider size restores after reload, expected ${after}px, got ${restored}px`);
});
