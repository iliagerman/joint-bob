import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { api, signIn } from "../dev-nodes.js";

test("focus actions use visible controls instead of multi-tap gestures", { timeout: 180_000 }, async t => {
  const fixture = await nativeUiFixture(t);
  const session = await signIn(fixture.environment, fixture.node);
  await api(fixture.node, session, "PUT", "/preferences", { focusUiEnabled: true });
  const context = await fixture.page.context().browser()!.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: "block" });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(fixture.node.url);
  await page.getByTestId("login-username-input").fill(fixture.environment.username);
  await page.getByTestId("login-password-input").fill(fixture.environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("body.focus-ui .project-card").first().waitFor();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().tap();
  await page.locator("#sessionList .session-card").first().tap();
  await page.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>("#messageInput")!.disabled);

  const fab = page.getByTestId("focus-controls-button");
  await fab.tap();
  await page.getByTestId("focus-new-note").tap();
  await page.getByTestId("quick-note-dialog").waitFor();
  await page.getByTestId("quick-note-cancel-button").tap();

  await fab.tap();
  await page.getByTestId("focus-recents").tap();
  await page.getByTestId("recent-sessions-dialog").waitFor();
  await page.getByTestId("recent-sessions-close-button").tap();
  assert.equal(await fab.isVisible(), true, "the controls button never needs a restore gesture");

  const title = await page.locator("#sessionTitle").boundingBox();
  assert.ok(title);
  for (let i = 0; i < 4; i++) await page.touchscreen.tap(title.x + 10, title.y + 10);
  assert.equal(await page.getByTestId("recent-sessions-dialog").isVisible(), false);
  assert.equal(await page.getByTestId("running-conversations-dialog").isVisible(), false);
  assert.equal(await fab.isVisible(), true);
});
