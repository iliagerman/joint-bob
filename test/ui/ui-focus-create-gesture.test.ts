import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { api, signIn } from "../dev-nodes.js";

test("mobile creation stays reachable through visible controls on lists and in chat", { timeout: 180_000 }, async t => {
  const fixture = await nativeUiFixture(t);
  await api(fixture.node, await signIn(fixture.environment, fixture.node), "PUT", "/preferences", { focusUiEnabled: true });
  const context = await fixture.page.context().browser()!.newContext({ viewport: { width: 390, height: 650 }, hasTouch: true, isMobile: true, serviceWorkers: "block" });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await page.goto(fixture.node.url);
  await page.getByTestId("login-username-input").fill(fixture.environment.username);
  await page.getByTestId("login-password-input").fill(fixture.environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().tap();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const search = await page.getByTestId("conversation-list-search-input").boundingBox();
  const plus = await page.getByTestId("conversation-search-create-button").boundingBox();
  assert.ok(search && plus && Math.abs(search.y + search.height / 2 - plus.y - plus.height / 2) < 2 && plus.x >= search.x + search.width, `plus sits beside search: ${JSON.stringify({ search, plus })}`);
  await page.getByTestId("conversation-search-create-button").tap();
  await page.getByTestId("new-session-name-dialog").waitFor();
  assert.equal(await page.getByTestId("new-session-project-select").textContent(), "Internal Assistant");
  await page.getByTestId("new-session-name-cancel-button").tap();

  await page.locator("#sessionList .session-card").first().tap();
  await page.getByTestId("focus-controls-button").tap();
  await page.getByTestId("focus-new-conversation").tap();
  await page.getByTestId("new-session-name-dialog").waitFor();
  assert.equal(await page.getByTestId("new-session-project-select").textContent(), "Internal Assistant", "chat menu creation defaults to the active project");
  await page.getByTestId("new-session-name-cancel-button").tap();

  await page.getByTestId("focus-controls-button").tap();
  await page.getByTestId("focus-new-note").tap();
  await page.getByTestId("quick-note-dialog").waitFor();
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("[data-testid='quick-note-save-button']")!.disabled);
  assert.equal(await page.getByTestId("quick-note-project-select").textContent(), "Internal Assistant");
  await page.getByTestId("quick-note-cancel-button").tap();

  await page.setViewportSize({ width: 1280, height: 900 });
  assert.equal(await page.getByTestId("conversation-search-create-button").isVisible(), false, "desktop unchanged");
});
