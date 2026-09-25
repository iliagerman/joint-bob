import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Locator, Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { api, signIn } from "../dev-nodes.js";

async function mobileFocusPage(t: TestContext) {
  const fixture = await nativeUiFixture(t);
  const session = await signIn(fixture.environment, fixture.node);
  await api(fixture.node, session, "PUT", "/preferences", { focusUiEnabled: true });
  const context = await fixture.page.context().browser()!.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: "block" });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(fixture.node.url);
  await page.getByTestId("login-username-input").fill(fixture.environment.username);
  await page.getByTestId("login-password-input").fill(fixture.environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("body.focus-ui .project-card").first().waitFor();
  return page;
}

async function assertNativeTap(page: Page, field: Locator) {
  await field.evaluate(element => {
    (document.activeElement as HTMLElement).blur();
    element.addEventListener("pointerdown", event => { element.setAttribute("data-tap-cancelled", String(event.defaultPrevented)); }, { once: true });
    element.addEventListener("click", event => {
      element.setAttribute("data-native-click", String(event.isTrusted && !event.defaultPrevented));
      element.setAttribute("data-focused-on-click", String(document.activeElement === element));
    }, { once: true });
  });
  await field.tap();
  assert.equal(await field.getAttribute("data-tap-cancelled"), "false", "focus gestures must not cancel native input activation");
  assert.equal(await field.getAttribute("data-native-click"), "true", "input must receive the trusted tap, not a delayed synthetic click");
  assert.equal(await field.getAttribute("data-focused-on-click"), "true", "input must focus during native activation, not from a timer");
  await page.keyboard.type("Mobile keyboard draft");
  assert.equal(await field.inputValue(), "Mobile keyboard draft");
}

test("mobile focus mode preserves native keyboard activation in search and the composer", { timeout: 90_000 }, async t => {
  const page = await mobileFocusPage(t);
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  const search = page.getByTestId("conversation-list-search-input");
  await assertNativeTap(page, search);
  await search.fill("");
  await page.locator("#sessionList .session-card").first().click();
  await page.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>("#messageInput")!.disabled);
  await assertNativeTap(page, page.getByTestId("chat-message-input"));
});

test("editing taps cancel pending focus gestures and retain native double-click selection", { timeout: 90_000 }, async t => {
  const page = await mobileFocusPage(t);
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card").first().click();
  await page.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>("#messageInput")!.disabled);
  const input = page.getByTestId("chat-message-input");
  const title = await page.locator("#sessionTitle").boundingBox();
  assert.ok(title);
  await page.touchscreen.tap(title.x + 10, title.y + 10);
  await page.touchscreen.tap(title.x + 10, title.y + 10);
  for (let i = 0; i < 3; i++) await input.tap();
  const selectionAllowed = await input.evaluate(element => element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })));
  assert.equal(selectionAllowed, true, "editing double-click must not be cancelled by a recent gesture");
  // Cross the gesture deadline before checking that no deferred navigation fired.
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 400)));
  assert.equal(await page.getByTestId("focus-controls-button").isVisible(), true, "entering an editor cancels pending chrome gestures");
  assert.equal(await page.getByTestId("recent-sessions-dialog").isVisible(), false);
  assert.equal(await input.evaluate(element => document.activeElement === element), true);
});
