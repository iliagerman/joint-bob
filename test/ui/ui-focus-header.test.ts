import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { api, signIn } from "../dev-nodes.js";

test("focus chat header stays one line with elapsed time and a working-only colored context number", { timeout: 180_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  const session = await signIn(environment, node);
  await api(node, session, "PUT", "/preferences", { focusUiEnabled: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card").first().click();
  await page.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>("#messageInput")!.disabled);
  await page.evaluate(async () => {
    const { state } = await import(new URL("/app/state.js", location.href).href);
    const { startDurationTicker } = await import(new URL("/app/chat-transcript.js", location.href).href);
    state.lastTurnStartedAt = Date.now() - 35_000;
    startDurationTicker();
  });
  await page.locator("#turnTimer").waitFor();
  for (const [percent, busy, color] of [[64, true, "--live"], [80, true, "--amber"], [95, false, "--danger"], [64, true, "--live"]] as const) {
    await page.evaluate(async ({ percent, busy }) => {
      const { updateStatus } = await import(new URL("/app/chat-controls.js", location.href).href);
      updateStatus({ isStreaming: busy, contextUsage: { percent }, thinkingLevel: "off", availableThinkingLevels: [] });
    }, { percent, busy });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const metrics = await page.evaluate(color => {
      const ids = ["sessionTitle", "chatProjectName", "turnTimer", "contextUsageText"];
      const rects = ids.map(id => { const r = document.getElementById(id)!.getBoundingClientRect(); return { id, center: r.y + r.height / 2, width: r.width }; });
      const number = document.querySelector<HTMLElement>("#contextUsageText")!;
      const probe = document.createElement("span"); probe.style.color = `var(${color})`; document.body.append(probe);
      const expectedColor = getComputedStyle(probe).color; probe.remove();
      return { rects, color: getComputedStyle(number).color, expectedColor, animation: getComputedStyle(number).animationName,
        timer: document.querySelector<HTMLElement>("#turnTimer")!.innerText,
        bar: document.querySelector<HTMLElement>(".context-usage-bar")!.checkVisibility(),
        overflow: document.documentElement.scrollWidth > innerWidth };
    }, color);
    assert.ok(Math.max(...metrics.rects.map(r => r.center)) - Math.min(...metrics.rects.map(r => r.center)) < 3, `one header row: ${JSON.stringify(metrics.rects)}`);
    assert.match(metrics.timer, /^\d+s$/, "only elapsed seconds, no Working prefix");
    assert.equal(metrics.bar, false);
    assert.equal(metrics.color, metrics.expectedColor);
    assert.equal(metrics.animation !== "none", busy, "only working context number pulses");
    assert.equal(metrics.overflow, false);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.locator("#contextUsageText").evaluate(el => getComputedStyle(el).animationName), "none");
  await page.screenshot({ path: "tmp/focus-single-line-header.png" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator(".context-usage-bar").isVisible(), true, "desktop retains the context bar");
  assert.match(await page.locator("#turnTimer").innerText(), /^Working /, "desktop retains its status label");
});
