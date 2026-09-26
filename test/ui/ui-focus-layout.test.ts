import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

for (const theme of ["light", "dark"]) test(`focus mobile headers and transparent FAB submenus stay compact and aligned (${theme})`, { timeout: 180_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card").first().waitFor();
  await page.getByTestId("app-menu-button").click();
  await page.getByTestId("app-menu-settings-button").click();
  if (theme === "dark") await page.getByTestId("settings-theme-toggle-button").click();
  await page.getByTestId("settings-focus-ui-toggle").check();
  await page.waitForFunction(() => document.body.classList.contains("focus-ui"));
  await page.getByTestId("settings-cancel-button").click();
  for (const view of ["projects", "sessions", "chat"]) {
    if (view === "sessions") await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
    if (view === "chat") await page.locator("#sessionList .session-card").first().click();
    await page.locator(`body.view-${view}`).waitFor();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator("#focusWorkspaceBar").isVisible(), false, "no duplicate workspace header above the screen header");
    const header = await page.locator(".shell > :visible > header").boundingBox();
    assert.ok(header && header.y <= 16 && header.height <= 80, `${view} has one compact header: ${JSON.stringify(header)}`);
    const icons = await page.locator(".shell > :visible > header button:visible svg").evaluateAll(elements => elements.map(el => el.getBoundingClientRect().width));
    assert.ok(icons.every(width => width <= 24), `header icons stay within their buttons: ${icons}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `tmp/focus-${theme}-${view}.png` });
    await page.getByTestId("focus-controls-button").click();
    const menu = await page.locator("#focusControls").boundingBox();
    assert.ok(menu && menu.height <= 430, `root menu is compact, not a toolbar dump: ${JSON.stringify(menu)}`);
    for (const id of ["focus-new-conversation", "focus-new-note", "focus-reviews", "focus-running", "focus-settings"]) {
      const button = page.getByTestId(id);
      assert.equal(await button.locator("svg").count(), 1, `${id} has an outline icon`);
      assert.equal(await button.evaluate(el => getComputedStyle(el).backgroundColor), "rgba(0, 0, 0, 0)", `${id} is transparent, not browser-grey`);
    }
    await page.screenshot({ path: `tmp/focus-${theme}-${view}-menu.png` });
    await page.getByTestId("focus-close").click();
  }
  await page.getByTestId("focus-controls-button").click();
  assert.equal(await page.locator("#chatToolbar").isVisible(), false);
  await page.getByTestId("focus-tools").click();
  assert.equal(await page.getByTestId("chat-open-browser-button").isVisible(), true);
  assert.equal(await page.getByTestId("chat-model-button").isVisible(), false);
  await page.screenshot({ path: `tmp/focus-${theme}-tools.png` });
  await page.keyboard.press("Escape");
  await page.getByTestId("focus-agent").click();
  assert.equal(await page.getByTestId("chat-model-button").isVisible(), true);
  assert.equal(await page.getByTestId("chat-open-browser-button").isVisible(), false);
  await page.screenshot({ path: `tmp/focus-${theme}-agent.png` });
  await page.getByTestId("focus-back").click();
  await page.setViewportSize({ width: 390, height: 460 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  for (const id of ["focus-new-conversation", "focus-new-note", "focus-reviews", "focus-running"]) {
    const box = await page.getByTestId(id).boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= 460, `${id} fits a short viewport: ${JSON.stringify(box)}`);
  }
  await page.getByTestId("focus-settings").click();
  await page.getByTestId("settings-focus-ui-toggle").uncheck();
  await page.getByTestId("settings-cancel-button").click();
  await page.locator("#chatPanel > #chatToolbar").waitFor({ state: "attached" });
  assert.equal(await page.locator("#chatPanel > #chatToolbar").count(), 1);
  assert.deepEqual(errors, [], "focus navigation has no page errors");
});
