import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("peer-reported running conversation returns to review without a dashboard or another socket event", { timeout: 120_000 }, async (t) => {
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
  assert.equal(await page.evaluate(`(async () => {
    const { state } = await import('/app/state.js');
    const { closeWatchSocket, closeSocket, refreshSessionsQuietly } = await import('/app/socket.js');
    closeWatchSocket(); closeSocket();
    while (state.sessionsRefreshing) await new Promise(resolve => setTimeout(resolve, 20));
    const id = state.sessions.find(session => session.title === 'Short one').id;
    const endpoint = '/api/projects/' + encodeURIComponent(state.activeProjectId) + '/sessions';
    const originalFetch = window.fetch;
    window.__runningPollTest = { running: true, requests: 0 };
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (new URL(String(args[0]), location.href).pathname !== endpoint) return response;
      const body = await response.json();
      window.__runningPollTest.requests++;
      for (const session of body.sessions) {
        delete session.agentRuns;
        session.running = session.id === id && window.__runningPollTest.running;
        session.reviewState = session.running ? 'running' : 'needs_review';
      }
      return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
    };
    await refreshSessionsQuietly();
    if (!state.sessions.find(session => session.id === id).running) throw Error('Running precondition missing');
    if (state.sessions.some(session => session.agentRuns?.length)) throw Error('Test must not have dashboard records');
    return true;
  })()`), true);
  await page.waitForFunction(() => [...document.querySelectorAll("#sessionList .list-row")].find(row => row.textContent.includes("Short one"))?.querySelector(".chat-badge b").textContent === "Running");
  await page.evaluate('window.__runningPollTest.running = false');
  await page.waitForFunction(() => [...document.querySelectorAll("#sessionList .list-row")].find(row => row.textContent.includes("Short one"))?.querySelector(".chat-badge b").textContent === "Needs review");
  assert.equal(await page.evaluate(`(async () => {
    const { state } = await import('/app/state.js');
    return window.__runningPollTest.requests >= 2 && state.agentRunPollTimer === null;
  })()`), true, "completion is polled and polling stops when all conversations are idle");
});
