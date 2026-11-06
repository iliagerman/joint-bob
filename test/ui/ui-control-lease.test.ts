import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("a card opens its conversation over the board to watch; taking control lets the person reply, and closing gives it back", async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length === 3 && !document.body.classList.contains("booting"));
  await page.waitForFunction(async () => (await import("/app/state.js")).state.preferencesLoaded);
  await page.waitForTimeout(500);

  // A real conversation from the seeded projects, shown as a running card.
  const real = await page.evaluate(`(async () => {
    const { projects } = await (await fetch('/api/projects')).json();
    for (const project of projects) {
      const { sessions } = await (await fetch('/api/projects/' + project.id + '/sessions')).json();
      if (sessions.length) { const session = sessions[0]; return { projectId: project.id, projectName: project.name, conversationId: session.conversationId ?? session.id, sessionId: session.id, path: session.path, title: session.title }; }
    }
    throw new Error('no seeded conversation');
  })()`) as { projectId: string; projectName: string; conversationId: string; sessionId: string; path: string; title: string };
  await page.evaluate(`(() => {
    const originalFetch = window.fetch;
    const real = ${JSON.stringify(real)};
    window.__lease = [];
    window.__held = null;
    window.fetch = async (...args) => {
      const path = new URL(String(args[0]), location.href).pathname;
      const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (path === '/api/control-center/board') {
        return reply({ projects: [{ id: real.projectId, name: real.projectName }], cards: [{ ...real, column: 'running', agentId: 'claude', agentLabel: 'Claude', agentModel: null, executionNodeId: null, updatedAt: null, turnRunning: true, backgroundRunning: false, summary: null, autoRespondActive: true, startedBy: 'bob', pendingReviews: [], autoRespondStop: null, controlledBy: window.__held }] });
      }
      if (path === '/api/control-center/summary') return reply({ waiting: 0 });
      if (path === '/api/control-center/lease') {
        const body = JSON.parse(args[1].body);
        window.__lease.push(body.action);
        window.__held = body.action === 'take' ? 'you' : null;
        return reply({ leased: body.action === 'take' });
      }
      return originalFetch(...args);
    };
  })()`);

  await page.getByTestId("projects-open-control-center-button").click();
  const card = page.getByTestId("control-center-card");
  await card.waitFor();
  assert.equal(await card.getByTestId("control-card-action-give-back").count(), 0);
  const composer = page.locator("#composer");
  const mode = page.getByTestId("control-popup-mode");

  // Opening a card shows the conversation over the board, to watch: Bob keeps driving and there is no message box.
  await card.locator(".control-title").click();
  await page.getByTestId("control-popup-bar").waitFor({ state: "visible" });
  assert.equal(await page.locator("body.view-control.control-popup").count(), 1, "the board stays under the conversation");
  assert.match(await mode.innerText(), /Watching · Bob keeps driving/);
  assert.equal(await composer.isVisible(), false, "watching has no message box");
  assert.deepEqual(await page.evaluate("window.__lease"), []);

  // Take control in the open view brings the message box and the banner; giving it back goes back to watching.
  await page.getByTestId("control-popup-take").click();
  await page.getByTestId("control-lease-banner").waitFor({ state: "visible" });
  await composer.waitFor({ state: "visible" });
  assert.match(await mode.innerText(), /You're in it/);
  assert.equal(await page.getByTestId("control-popup-take").isVisible(), false);
  // The whole message box fits in the window: the popup is never taller than the space under its top edge.
  const fit = await page.evaluate(() => ({ composer: document.querySelector("#composer")!.getBoundingClientRect().bottom, panel: document.querySelector("#chatPanel")!.getBoundingClientRect().bottom, window: innerHeight }));
  assert.ok(fit.composer <= fit.panel && fit.panel <= fit.window, `composer ${fit.composer}, panel ${fit.panel}, window ${fit.window}`);
  await page.getByTestId("control-lease-give-back").click();
  await page.getByTestId("control-lease-banner").waitFor({ state: "hidden" });
  await composer.waitFor({ state: "hidden" });
  assert.deepEqual(await page.evaluate("window.__lease"), ["take", "release"]);

  // Esc closes the conversation, not the control center.
  await page.keyboard.press("Escape");
  await page.getByTestId("control-popup-bar").waitFor({ state: "hidden" });
  assert.equal(await page.locator("body.view-control").count(), 1);

  // Take control on the card opens it already held; closing hands it back to Bob.
  await page.getByTestId("control-center-card").getByTestId("control-card-action-take-control").click();
  await page.getByTestId("control-lease-banner").waitFor({ state: "visible" });
  assert.equal(await page.locator("body.view-control.control-popup.control-held").count(), 1);
  await page.getByTestId("control-popup-close").click();
  await page.getByTestId("control-popup-bar").waitFor({ state: "hidden" });
  await page.waitForFunction(() => (window as unknown as { __lease: string[] }).__lease.length === 4);
  assert.deepEqual(await page.evaluate("window.__lease"), ["take", "release", "take", "release"]);

  // A conversation held elsewhere says so on its card, which offers the way back.
  await page.evaluate("window.__held = 'you'; window.dispatchEvent(new CustomEvent('control-center-changed'))");
  const held = page.getByTestId("control-center-card");
  await held.getByTestId("control-card-action-give-back").waitFor();
  assert.match(await held.innerText(), /You're in it/);
  await held.getByTestId("control-card-action-give-back").click();
  await page.getByTestId("control-card-action-take-control").waitFor();
  assert.deepEqual(await page.evaluate("window.__lease"), ["take", "release", "take", "release", "release"]);
});
