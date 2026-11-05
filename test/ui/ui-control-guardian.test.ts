import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

const card = (overrides: Record<string, unknown>) => ({
  projectId: "p1", projectName: "Contigos · Julian", conversationId: "c1", sessionId: "c1", path: "/c1", title: "Prod 5xx", column: "needs-you", agentId: "claude", agentLabel: "Claude", agentModel: null,
  executionNodeId: null, updatedAt: "2026-11-05T10:00:00Z", turnRunning: true, backgroundRunning: false, summary: null, autoRespondActive: false, startedBy: "bob", pendingReviews: [], autoRespondStop: null, ...overrides,
});

const BOARD = {
  projects: [{ id: "p1", name: "Contigos · Julian" }],
  cards: [
    card({ pendingReviews: [{ id: "r1", title: "Claude wants to run a command", subject: "aws ecs update-service --force-new-deployment", detail: "Production or destructive steps · 98%", expiresAt: "2026-11-05T10:10:00Z" }] }),
    card({ conversationId: "c2", sessionId: "c2", title: "Replace Syncthing", turnRunning: false, autoRespondStop: { kind: "stop-instruction", reason: "A plan waits for approval" }, startedBy: "you" }),
    card({ conversationId: "c3", sessionId: "c3", title: "Mobile menu", column: "running", startedBy: "you" }),
  ],
};

test("a step waiting for your OK shows under Needs you with answer buttons, and the icon says how many things wait", async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length === 3 && !document.body.classList.contains("booting"));
  await page.waitForFunction(async () => (await import("/app/state.js")).state.preferencesLoaded);
  await page.waitForTimeout(500);
  await page.evaluate(`(() => {
    const originalFetch = window.fetch;
    window.__decisions = [];
    window.__board = ${JSON.stringify(BOARD)};
    window.fetch = async (...args) => {
      const path = new URL(String(args[0]), location.href).pathname;
      const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (path === '/api/control-center/board') return reply(window.__board);
      if (path === '/api/control-center/summary') return reply({ waiting: 2 });
      if (path === '/api/control-center/guardian/decide') {
        window.__decisions.push(JSON.parse(args[1].body));
        window.__board = { ...window.__board, cards: window.__board.cards.filter((card) => !card.pendingReviews.length) };
        return reply({ ok: true });
      }
      return originalFetch(...args);
    };
    window.dispatchEvent(new CustomEvent('control-center-changed'));
  })()`);

  await page.getByTestId("control-center-waiting-badge").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("control-center-waiting-badge").textContent(), "2");

  await page.getByTestId("projects-open-control-center-button").click();
  await page.waitForSelector('[data-testid="control-center-card"]');
  assert.equal(await page.getByTestId("control-center-count").textContent(), "1 running · 2 need you · 1 watched by Bob");
  const review = page.locator('[data-key="p1:c1"]');
  assert.equal(await review.getAttribute("data-column"), "needs-you");
  assert.match(await review.innerText(), /aws ecs update-service --force-new-deployment/);
  assert.match(await page.locator('[data-key="p1:c2"]').innerText(), /Auto respond stopped[\s\S]*A plan waits for approval/);
  assert.equal(await page.getByTestId("control-tab-live").textContent(), "Live agents3");

  await review.getByTestId("control-review-allow").click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="control-center-card"]').length === 2);
  assert.deepEqual(await page.evaluate("window.__decisions"), [{ projectId: "p1", conversationId: "c1", reviewId: "r1", decision: "allow" }]);

  // Bob's settings say whether production steps ask first, and an administrator can turn it on.
  await page.getByTestId("control-chat-settings-button").click();
  await page.getByTestId("control-bob-guard-button").waitFor({ state: "visible" });
  assert.match(await page.getByTestId("control-bob-guard").innerText(), /Guardian is off/);
  await page.getByTestId("control-bob-guard-button").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="control-bob-guard"]')?.textContent?.includes("ask you first"));
  assert.equal(await page.getByTestId("control-bob-guard-button").isHidden(), true);
});
