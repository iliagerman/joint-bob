import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { api, signIn } from "../dev-nodes.js";

test("mobile focus menu opens auto respond at once while slow model lists load", { timeout: 120_000 }, async t => {
  const fixture = await nativeUiFixture(t);
  await api(fixture.node, await signIn(fixture.environment, fixture.node), "PUT", "/preferences", { focusUiEnabled: true });
  const context = await fixture.page.context().browser()!.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.goto(fixture.node.url);
  await page.getByTestId("login-username-input").fill(fixture.environment.username);
  await page.getByTestId("login-password-input").fill(fixture.environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card").first().click();
  await page.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>("#messageInput")!.disabled);
  // Production listed harnesses and models in about two seconds; the dialog appeared only after that.
  let release!: () => void;
  const listsLoaded = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\/api\/(harnesses|models)$/, async route => { await listsLoaded; await route.continue(); });

  await page.getByTestId("focus-controls-button").tap();
  await page.getByTestId("focus-auto-respond").tap();
  await page.getByTestId("auto-respond-dialog").waitFor({ timeout: 1500 });
  assert.equal(await page.locator("#focusControls").isVisible(), false, "the dialog replaces the controls menu");
  assert.match(await page.getByTestId("auto-respond-instructions").inputValue(), /Answer as the user would/);
  assert.equal(await page.getByTestId("auto-respond-save-button").isDisabled(), true, "saving waits for the harness list");

  release();
  await page.getByTestId("auto-respond-harness").locator("option").first().waitFor({ state: "attached" });
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#saveAutoRespondButton")!.disabled);
  assert.notEqual(await page.getByTestId("auto-respond-harness").inputValue(), "", "a harness is chosen once the list arrives");
  await page.getByTestId("auto-respond-cancel-button").tap();
  await page.getByTestId("auto-respond-dialog").waitFor({ state: "hidden" });
});
