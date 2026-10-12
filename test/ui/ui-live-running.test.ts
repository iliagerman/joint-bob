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

test("a notice about the open project rescans every project only when its running set changed", { timeout: 120_000 }, async (t) => {
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
    const settled = async () => {
      await new Promise(resolve => setTimeout(resolve, 400));
      while (state.sessionsRefreshing) await new Promise(resolve => setTimeout(resolve, 20));
      await new Promise(resolve => setTimeout(resolve, 400));
    };
    await settled();
    // Scans scheduled while the page loaded are not this test's subject.
    clearTimeout(state.pendingReviewsRefreshTimer);
    state.pendingReviewsRefreshTimer = null;
    let sessions = state.sessions.map(session => ({ ...session, running: false, turnRunning: false, backgroundRunning: false }));
    state.sessions = sessions;
    const scans = { running: 0 };
    const originalFetch = window.fetch;
    const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    window.fetch = async (...args) => {
      const pathname = new URL(String(args[0]), location.href).pathname;
      if (pathname === '/api/running') { scans.running += 1; return json({ projects: [] }); }
      if (pathname.endsWith('/sessions')) return json({ sessions });
      return originalFetch(...args);
    };
    const notice = { type: 'sessionsChanged', projectId: state.activeProjectId };
    for (let index = 0; index < 5; index += 1) handleSocketPayload(notice);
    await settled();
    const unchanged = { running: scans.running, reviews: Boolean(state.pendingReviewsRefreshTimer) };
    sessions = sessions.map((session, index) => index ? session : { ...session, running: true, turnRunning: true });
    handleSocketPayload(notice);
    await settled();
    const started = scans.running;
    handleSocketPayload({ type: 'sessionsChanged' });
    await settled();
    return { unchanged, started, unnamed: scans.running };
  })()`) as { unchanged: { running: number; reviews: boolean }; started: number; unnamed: number };
  assert.deepEqual(result.unchanged, { running: 0, reviews: false }, "notices that changed nothing must not list every project");
  assert.equal(result.started, 1, "a conversation that started running must refresh the running list");
  assert.equal(result.unnamed, 2, "a notice that names no project still refreshes the running list");
});
