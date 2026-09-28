import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { api, signIn } from "../dev-nodes.js";

test("mobile creation works through visible controls and C/N gestures", { timeout: 180_000 }, async t => {
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
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.getByTestId("conversation-list-search-input").waitFor();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const search = await page.getByTestId("conversation-list-search-input").boundingBox();
  const plus = await page.getByTestId("conversation-search-create-button").boundingBox();
  assert.ok(search && plus && Math.abs(search.y + search.height / 2 - plus.y - plus.height / 2) <= 4 && plus.x >= search.x + search.width, `plus sits beside search: ${JSON.stringify({ search, plus })}`);
  await page.getByTestId("conversation-search-create-button").tap();
  await page.getByTestId("new-session-name-dialog").waitFor();
  assert.equal(await page.getByTestId("new-session-project-select").textContent(), "Internal Assistant");
  await page.getByTestId("new-session-name-cancel-button").tap();

  await page.locator("#sessionList .session-card").first().click();
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
  await page.getByTestId("quick-note-dialog").waitFor({ state: "hidden" });

  const cdp = await context.newCDPSession(page);
  const draw = async (points: Array<{ x: number; y: number }>) => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [points[0]] });
    for (const point of points.slice(1)) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  await draw(Array.from({ length: 41 }, (_, i) => ({ x: 190 + 80 * Math.cos(-Math.PI / 3 - i * Math.PI / 30), y: 400 + 80 * Math.sin(-Math.PI / 3 - i * Math.PI / 30) })));
  await page.getByTestId("new-session-name-dialog").waitFor();
  assert.equal(await page.getByTestId("new-session-project-select").textContent(), "Internal Assistant", "C opens conversation creation for the active project");
  await page.getByTestId("new-session-name-cancel-button").tap();
  await page.getByTestId("new-session-name-dialog").waitFor({ state: "hidden" });

  const corners = [{ x: 120, y: 470 }, { x: 120, y: 220 }, { x: 270, y: 470 }, { x: 270, y: 220 }];
  const startTarget = await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    const blocked = target?.closest("button:not(.session-card):not(.project-card),input,textarea,select,a,summary,label,[contenteditable],#browserPanel,.xterm,.canvas-root");
    return { tag: target?.tagName, id: target?.id, className: target?.className, blocked: blocked?.outerHTML.slice(0, 120) };
  }, corners[0]);
  assert.equal(startTarget.blocked, undefined, `N starts outside controls: ${JSON.stringify(startTarget)}`);
  await draw(corners.slice(1).flatMap((end, segment) => Array.from({ length: 16 }, (_, i) => ({
    x: corners[segment].x + (end.x - corners[segment].x) * i / 15,
    y: corners[segment].y + (end.y - corners[segment].y) * i / 15,
  }))));
  await page.getByTestId("quick-note-dialog").waitFor();
  assert.equal(await page.getByTestId("quick-note-project-select").textContent(), "Internal Assistant", "N opens note creation for the active project");
  await page.getByTestId("quick-note-cancel-button").tap();

  await page.setViewportSize({ width: 1280, height: 900 });
  assert.equal(await page.getByTestId("conversation-search-create-button").isVisible(), false, "desktop unchanged");
});
