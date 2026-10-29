import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { api, signIn } from "../dev-nodes.js";

test("mobile focus menu names the execution node and switches it", { timeout: 120_000 }, async t => {
  const fixture = await nativeUiFixture(t);
  await api(fixture.node, await signIn(fixture.environment, fixture.node), "PUT", "/preferences", { focusUiEnabled: true });
  const context = await fixture.page.context().browser()!.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: "block" });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(fixture.node.url);
  await page.getByTestId("login-username-input").fill(fixture.environment.username);
  await page.getByTestId("login-password-input").fill(fixture.environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card").first().click();
  await page.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>("#messageInput")!.disabled);
  await page.evaluate(async () => {
    const { state } = await import(new URL("/app/state.js", location.href).href);
    const { renderChatSessionControls } = await import(new URL("/app/chat-controls.js", location.href).href);
    state.sessionNodes = [
      ...state.sessionNodes,
      { id: "laptop-node", name: "Laptop", online: true, mapped: true, local: false, runner: true },
      { id: "attic-node", name: "Attic", online: false, mapped: true, local: false },
    ];
    renderChatSessionControls();
    const recorded = window as Window & { nodeChoices: string[] };
    recorded.nodeChoices = [];
    // Record the choice instead of moving the conversation to a machine that does not exist.
    document.addEventListener("change", event => {
      const select = event.target as HTMLSelectElement;
      if (select.id !== "chatNodeSelect") return;
      event.stopPropagation();
      recorded.nodeChoices.push(select.value);
    }, true);
  });
  // Switch to the laptop, then back to this node. Choosing keeps the menu open; closing it is a separate tap.
  for (const [activate, from, to] of [["click", 0, 1], ["tap", 1, 0]] as const) {
    await page.getByTestId("focus-controls-button")[activate]();
    const options = page.getByTestId("focus-node-option");
    await options.first().waitFor();
    assert.equal(await page.locator("#focusControls").isVisible(), true, `${activate}: the nodes are listed inside the menu`);
    assert.deepEqual(await options.allInnerTexts(), [`${fixture.node.name} · local`, "Laptop", "Attic · offline"]);
    assert.deepEqual(await options.evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-pressed"))), [0, 1, 2].map(index => String(index === from)), `${activate}: the current node is marked`);
    assert.equal(await options.nth(2).isDisabled(), true, `${activate}: a node that is switched off cannot be chosen`);
    await options.nth(to)[activate]();
    assert.equal(await page.locator("#focusControls").isVisible(), true, `${activate}: choosing a node keeps the menu open`);
    // A tap is confirmed by the tap-gesture timer, so the mark can arrive after the tap returns.
    await page.waitForFunction(pressed => [...document.querySelectorAll("[data-testid='focus-node-option']")].map(button => button.getAttribute("aria-pressed")).join(",") === pressed, [0, 1, 2].map(index => String(index === to)).join(","));
    await page.getByTestId("focus-close")[activate]();
    await page.locator("#focusControls").waitFor({ state: "hidden" });
  }
  const localNodeId = await page.evaluate(async () => (await import(new URL("/app/state.js", location.href).href)).state.sessionNodes.find((node: { local: boolean }) => node.local).id);
  assert.deepEqual(await page.evaluate(() => (window as Window & { nodeChoices: string[] }).nodeChoices), ["laptop-node", localNodeId]);
  assert.deepEqual(errors, [], "choosing a node has no page errors");
});
