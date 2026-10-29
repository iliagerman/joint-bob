import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { api, signIn } from "../dev-nodes.js";

test("mobile menu model and effort dropdowns are searchable and keep the controls open", { timeout: 120_000 }, async t => {
  const fixture = await nativeUiFixture(t);
  await api(fixture.node, await signIn(fixture.environment, fixture.node), "PUT", "/preferences", { focusUiEnabled: true });
  const context = await fixture.page.context().browser()!.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: "block" });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.goto(fixture.node.url);
  await page.getByTestId("login-username-input").fill(fixture.environment.username);
  await page.getByTestId("login-password-input").fill(fixture.environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card").first().click();
  await page.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>("#messageInput")!.disabled);
  await page.evaluate(async () => {
    const { state } = await import(new URL("/app/state.js", location.href).href);
    const recordedWindow = window as Window & { controlMessages: unknown[] };
    recordedWindow.controlMessages = [];
    state.socket.send = (message: string) => recordedWindow.controlMessages.push(JSON.parse(message));
  });
  for (const activate of ["click", "tap"] as const) {
    await page.getByTestId("focus-controls-button")[activate]();
    await page.evaluate(async () => {
      const { state } = await import(new URL("/app/state.js", location.href).href);
      const { renderReasoningOptions } = await import(new URL("/app/composer-dialogs.js", location.href).href);
      state.models = [
        { harnessId: state.engine, provider: "fixture", id: "test-model", label: "Test model" },
        { harnessId: state.engine, provider: "fixture", id: "other-model", label: "Other model" },
      ];
      state.availableThinkingLevels = ["low", "high"];
      state.thinkingLevel = "low";
      renderReasoningOptions();
      document.querySelector<HTMLButtonElement>("#modelButton")!.disabled = false;
      const { syncQuickActionLabels } = await import(new URL("/app/focus-ui.js", location.href).href);
      syncQuickActionLabels();
    });
    await page.getByTestId("focus-model")[activate]();
    await page.getByTestId("focus-model-search").fill("test");
    assert.equal(await page.getByTestId("focus-model-option").count(), 1, `${activate}: search narrows the model list`);
    assert.equal(await page.locator("#focusControls").isVisible(), true, `${activate}: the model list opens inside the menu`);
    await page.getByTestId("focus-model-option").filter({ hasText: "Test model" })[activate]();
    assert.equal(await page.locator("#focusControls").isVisible(), true, `${activate}: choosing a model keeps the menu open`);
    await page.getByTestId("focus-effort")[activate]();
    await page.getByTestId("focus-effort-option").filter({ hasText: /^high$/ })[activate]();
    await page.waitForFunction(() => document.querySelector<HTMLSelectElement>("#reasoningLevelSelect")!.value === "high");
    assert.equal(await page.getByTestId("chat-reasoning-select").inputValue(), "high");
    assert.equal(await page.locator("#focusControls").isVisible(), true, `${activate}: choosing effort keeps the menu open`);
    await page.getByTestId("focus-close")[activate]();
    await page.locator("#focusControls").waitFor({ state: "hidden" });
  }
  // The socket's keepalive ping fires on a timer; only the control messages are under test.
  const messages = await page.evaluate(() => (window as Window & { controlMessages: { type: string }[] }).controlMessages.filter(message => message.type !== "ping"));
  assert.deepEqual(messages, Array.from({ length: 2 }, () => [
    { type: "setModel", provider: "fixture", modelId: "test-model" }, { type: "setThinking", level: "high" },
  ]).flat());
});
