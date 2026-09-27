import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("live start renders the conversation immediately and refreshes the running badge within one second", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.locator('#loginDialog[open]').waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length === 3);
  await page.locator("#projectList .list-row", { hasText: "Internal Assistant" }).locator("button").first().click();
  await page.locator('[data-filter="all"]').click();
  await page.locator("#sessionList .list-row", { hasText: "Short one" }).waitFor();
  const result = await page.evaluate(`(async () => {
    const { state } = await import('/app/state.js');
    const { closeWatchSocket, closeSocket, handleSocketPayload } = await import('/app/socket.js');
    closeWatchSocket(); closeSocket();
    while (state.sessionsRefreshing) await new Promise(resolve => setTimeout(resolve, 20));
    const session = state.sessions.find(session => session.title === 'Short one');
    state.activeSessionId = session.id;
    state.activeSessionPath = session.path;
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const pathname = new URL(String(args[0]), location.href).pathname;
      if (pathname === '/api/running') return new Response(JSON.stringify({ projects: [{
        projectId: state.activeProjectId, projectName: 'Internal Assistant',
        sessions: [{ ...session, running: true, turnRunning: true }],
      }] }), { headers: { 'content-type': 'application/json' } });
      // The immediate row update must not depend on a list HTTP response.
      if (pathname.endsWith('/sessions')) return new Promise(() => {});
      return originalFetch(...args);
    };
    const label = () => [...document.querySelectorAll('#sessionList .list-row')]
      .find(row => row.textContent.includes('Short one')).querySelector('.chat-badge b').textContent;
    const before = label();
    handleSocketPayload({ type: 'agent_start' });
    handleSocketPayload({ type: 'sessionsChanged' });
    return { before, after: label() };
  })()`);
  assert.notEqual(result.before, "Running", "fixture must start idle");
  assert.equal(result.after, "Running", "agent_start must render Running without waiting for the sessions API");
  await page.waitForFunction(() => {
    const badge = document.querySelector('[data-testid="running-conversations-open-button"] [data-running-count]') as HTMLElement;
    return !badge.hidden && badge.textContent === "1";
  }, null, { timeout: 1000 });
});
