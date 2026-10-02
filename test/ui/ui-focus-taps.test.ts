import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { api, signIn } from "../dev-nodes.js";

test("focus controls support single, double, and triple taps", { timeout: 180_000 }, async t => {
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
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card").first().click();
  await page.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>("#messageInput")!.disabled);

  const fab = page.getByTestId("focus-controls-button");
  await fab.tap();
  await page.getByTestId("focus-new-note").tap();
  await page.getByTestId("quick-note-dialog").waitFor();
  await page.getByTestId("quick-note-cancel-button").tap();
  await page.getByTestId("quick-note-dialog").waitFor({ state: "hidden" });

  const title = await page.locator("#sessionTitle").boundingBox();
  assert.ok(title);
  const tapTitle = async (count: number) => {
    for (let i = 0; i < count; i++) await page.touchscreen.tap(title.x + title.width / 2, title.y + title.height / 2);
  };
  await tapTitle(2);
  await page.waitForFunction(() => document.querySelector<HTMLElement>("#focusControlsButton")!.hidden);
  await tapTitle(2);
  await page.waitForFunction(() => !document.querySelector<HTMLElement>("#focusControlsButton")!.hidden);
  await tapTitle(3);
  await page.getByTestId("recent-sessions-dialog").waitFor();
  assert.equal(await fab.isVisible(), true, "triple tap leaves the controls button visible");
  await page.getByTestId("recent-sessions-close-button").tap();
  await page.getByTestId("recent-sessions-dialog").waitFor({ state: "hidden" });

  await page.locator("#messageInput").fill("double-tap send");
  const send = await page.getByTestId("chat-send-button").boundingBox();
  assert.ok(send);
  for (let i = 0; i < 2; i++) await page.touchscreen.tap(send.x + send.width / 2, send.y + send.height / 2);
  await page.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>("#messageInput")!.value);
  assert.equal(await fab.isVisible(), true, "double-tapping send must not hide the controls button");

  await page.evaluate(`(async () => {
    const { state } = await import('/app/state.js');
    state.conversationCommands = { start: { enabled: false, prompt: '' }, end: { enabled: true, prompt: 'Finish and push.' } };
    window.sentPrompts = [];
    state.socket = { readyState: WebSocket.OPEN, send(value) { window.sentPrompts.push(JSON.parse(value).message); } };
    document.querySelector('#messageInput').value = 'Keep this draft';
  })()`);
  for (let i = 0; i < 2; i++) await page.touchscreen.tap(send.x + send.width / 2, send.y + send.height / 2);
  await page.waitForTimeout(450);
  assert.deepEqual(await page.evaluate('window.sentPrompts'), ["Finish and push."], "double-tap Send runs the end command once");
  assert.equal(await page.locator("#messageInput").inputValue(), "Keep this draft");

  const start = await fab.boundingBox();
  assert.ok(start);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: start.x + start.width / 2, y: start.y + start.height / 2 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 70, y: 160 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const moved = await fab.boundingBox();
  assert.ok(moved && moved.x < 100 && moved.y < 180, `touch drag moves controls button: ${JSON.stringify({ start, moved })}`);
  assert.equal(await page.locator("#focusControls").isVisible(), false, "drag does not open controls");
});
