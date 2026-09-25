import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { api, signIn } from "../dev-nodes.js";

test("focus UI is opt-in, uses real conversations, and reverts without losing the draft", { timeout: 180_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card").first().waitFor();
  assert.equal(await page.locator("body").evaluate(el => el.classList.contains("focus-ui")), false);
  await page.getByTestId("settings-open-button").click();
  await page.route("**/api/preferences", route => route.request().method() === "PUT"
    ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Preference store unavailable" }) })
    : route.continue());
  await page.getByTestId("settings-focus-ui-toggle").check();
  await page.getByText("Could not save interface preference: Preference store unavailable", { exact: true }).waitFor();
  assert.equal(await page.getByTestId("settings-focus-ui-toggle").isChecked(), false);
  assert.equal(await page.locator("body").evaluate(el => el.classList.contains("focus-ui")), false);
  await page.unroute("**/api/preferences");
  await page.getByTestId("settings-focus-ui-toggle").check();
  await page.waitForFunction(() => document.body.classList.contains("focus-ui"));
  await page.locator("#cancelSettingsButton").click();
  await page.reload();
  await page.locator("body.focus-ui .project-card").first().waitFor();
  assert.equal(await page.locator("#chatsPanel").isVisible(), false);
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card").first().waitFor();
  assert.equal(await page.locator("#projectsPanel").isVisible(), false);
  await page.locator("#sessionList .session-card").first().click();
  await page.locator("body.view-chat.focus-ui").waitFor();
  await page.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>("#messageInput")!.disabled);
  await page.locator("#messageInput").fill("Keep my real conversation draft");
  const title = await page.locator("#sessionTitle").innerText();
  assert.equal(await page.locator("#chatToolbar").isVisible(), false);
  assert.equal(await page.locator("#chatsPanel").isVisible(), false);
  await page.getByTestId("focus-controls-button").click();
  assert.equal(await page.locator("#chatToolbar").isVisible(), false);
  await page.getByTestId("focus-tools").click();
  assert.equal(await page.locator("#chatToolbar").isVisible(), true);
  assert.equal(await page.getByTestId("chat-open-browser-button").isVisible(), true);
  await page.getByTestId("focus-new-conversation").click();
  const projectPicker = page.getByTestId("new-session-project-select");
  await projectPicker.waitFor({ state: "visible" });
  await projectPicker.focus();
  assert.equal(await page.getByTestId("new-session-project-option").count(), node.projects.length, "opening the picker shows every project before searching");
  await projectPicker.fill("joint");
  await page.getByTestId("new-session-project-option").getByText("Joint Bob", { exact: true }).click();
  await page.getByTestId("new-session-name-cancel-button").click();
  assert.equal(await page.locator("#sessionTitle").innerText(), title, "cancelling another-project wizard keeps current chat");
  assert.equal(await page.locator("#messageInput").inputValue(), "Keep my real conversation draft");
  await page.getByTestId("focus-controls-button").click();
  await page.getByTestId("focus-settings").click();
  await page.getByTestId("settings-focus-ui-toggle").uncheck();
  await page.waitForFunction(() => !document.body.classList.contains("focus-ui"));
  await page.locator("#cancelSettingsButton").click();
  assert.equal(await page.locator("#projectsPanel").isVisible(), true);
  assert.equal(await page.locator("#chatsPanel").isVisible(), true);
  assert.equal(await page.locator("#chatPanel > #chatToolbar").isVisible(), true, "real toolbar returns to original parent");
  assert.equal(await page.locator("#messageInput").inputValue(), "Keep my real conversation draft");
  await page.reload();
  await page.locator(".project-card").first().waitFor();
  assert.equal(await page.locator("body").evaluate(el => el.classList.contains("focus-ui")), false);
});

test("mobile focus gestures, fixed composer and cross-project creation use the live app", { timeout: 180_000 }, async t => {
  const fixture = await nativeUiFixture(t);
  const session = await signIn(fixture.environment, fixture.node);
  for (const project of fixture.node.projects.filter(project => ["Internal Assistant", "Joint Bob"].includes(project.name))) {
    const response = await api(fixture.node, session, "POST", "/secrets/accounts", {
      label: `${project.name} test account`, provider: "custom", projectId: project.id,
      variables: [{ name: "SYNTHETIC_FOCUS_TOKEN", kind: "value", value: "isolated-fixture-only" }],
    });
    assert.equal(response.status, 201);
  }
  const context = await fixture.page.context().browser()!.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: "block" });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(fixture.node.url);
  await page.getByTestId("login-username-input").fill(fixture.environment.username);
  await page.getByTestId("login-password-input").fill(fixture.environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card").first().waitFor();
  await page.getByTestId("app-menu-button").click();
  await page.getByTestId("app-menu-settings-button").click();
  await page.getByTestId("settings-focus-ui-toggle").check();
  await page.waitForFunction(() => document.body.classList.contains("focus-ui"));
  await page.getByTestId("settings-cancel-button").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card").first().click();
  await page.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>("#messageInput")!.disabled);
  await page.locator("#messageInput").fill("Draft before another project");
  const originalTitle = await page.locator("#sessionTitle").innerText();
  // A real fixture transcript, deliberately viewed through a shorter viewport.
  await page.setViewportSize({ width: 390, height: 460 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(() => {
    const messages = document.querySelector("#messages")!;
    return messages.scrollHeight > messages.clientHeight;
  });
  const before = await page.locator("#messageInput").boundingBox();
  assert.ok(before && before.y >= 0 && before.y + before.height <= 460, "composer fits visible viewport");
  await page.locator("#messages").evaluate(el => el.scrollTo(0, 0));
  await page.locator("#messages").evaluate(el => el.scrollTo(0, el.scrollHeight));
  assert.ok(await page.locator("#messages").evaluate(el => el.scrollTop) > 0);
  assert.deepEqual(await page.locator("#messageInput").boundingBox(), before, "scrolling transcript never moves composer");
  await page.setViewportSize({ width: 390, height: 844 });
  const title = await page.locator("#sessionTitle").boundingBox();
  assert.ok(title);
  for (const visible of [false, true]) {
    await page.touchscreen.tap(title.x + 10, title.y + 10);
    await page.touchscreen.tap(title.x + 10, title.y + 10);
    await page.waitForFunction(expected => !document.querySelector<HTMLElement>("#focusControlsButton")!.hidden === expected, visible);
  }
  const fab = page.getByTestId("focus-controls-button");
  const start = await fab.boundingBox();
  assert.ok(start);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: start.x + 20, y: start.y + 20 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 70, y: 160 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const moved = await fab.boundingBox();
  assert.ok(moved && moved.x < 100 && moved.y < 180, "touch drag moves FAB");
  assert.equal(await page.locator("#focusControls").isVisible(), false, "drag does not open menu");
  await fab.tap();
  await page.getByTestId("focus-new-conversation").click();
  await page.getByTestId("new-session-project-select").fill("joint");
  await page.getByTestId("new-session-project-option").getByText("Joint Bob", { exact: true }).click();
  await page.getByTestId("new-session-name-input").fill("Cross-project focus conversation");
  await page.getByTestId("new-session-step-3").click();
  await page.locator("#newSessionSecretList").getByText("Joint Bob test account", { exact: false }).waitFor();
  assert.equal(await page.locator("#newSessionSecretList").getByText("Internal Assistant test account", { exact: false }).count(), 0, "accounts follow the selected target project, not the chat underneath");
  await page.waitForFunction(() => document.querySelector<HTMLSelectElement>("#newSessionNodeSelect")!.value !== "");
  const nodeSelect = page.getByTestId("new-session-node-select");
  await nodeSelect.selectOption(await nodeSelect.inputValue());
  assert.deepEqual(errors, [], "changing execution node must keep the secret picker usable");
  await page.getByTestId("new-session-name-start-button").click();
  await page.waitForFunction(() => document.querySelector("#sessionTitle")!.textContent === "Cross-project focus conversation");
  assert.equal(await page.locator("#chatProjectName").textContent(), "Joint Bob");
  await fab.tap();
  await page.getByTestId("focus-projects").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card", { hasText: originalTitle }).first().click();
  await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("#messageInput")!.value === "Draft before another project");
  await context.close();
});
