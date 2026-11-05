import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";

async function badgeFixture(t: TestContext): Promise<Page> {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.locator('#loginDialog[open]').waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.locator("#projectList .list-row", { hasText: "Internal Assistant" }).locator(".project-card").click();
  await page.locator("#sessionList .session-card").first().waitFor();
  await page.evaluate(async () => {
    const stateModule = "/app/state.js", socketModule = "/app/socket.js";
    const { state } = await import(stateModule);
    const { closeWatchSocket, closeSocket } = await import(socketModule);
    closeWatchSocket(); closeSocket();
    while (state.sessionsRefreshing) await new Promise(resolve => setTimeout(resolve, 20));
  });
  await page.evaluate(`(async () => {
    const { state } = await import('/app/state.js');
    const { renderSessions } = await import('/app/session-list.js');
    const { refreshRunningConversations } = await import('/app/running.js');
    const { refreshPendingReviews } = await import('/app/reviews.js');
    const template = state.sessions[0];
    const sessions = ['running', 'needs_review'].flatMap(reviewState => [
      {}, { cronTaskId: 'scheduled' }, { doneAt: '2026-01-01T00:00:00.000Z' },
      { cronTaskId: 'scheduled', doneAt: '2026-01-01T00:00:00.000Z' },
    ].map((visibility, index) => ({
      ...template, id: reviewState + index, path: reviewState + index, title: reviewState + index,
      reviewState, running: reviewState === 'running', turnRunning: reviewState === 'running',
      backgroundRunning: false, ...visibility,
    })));
    state.preferencesLoaded = false;
    state.projectConversationVisibility = {};
    state.showDoneConversations = false;
    state.showScheduledConversations = false;
    state.knownCronTaskIds = new Set(['scheduled']);
    state.hiddenCronTaskIds = new Set();
    state.chatFilters.clear();
    state.sessions = sessions;
    const projects = state.projects.filter(p => ['Internal Assistant', 'Joint Bob'].includes(p.name))
      .map(p => ({ projectId: p.id, projectName: p.name, sessions }));
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const pathname = new URL(String(args[0]), location.href).pathname;
      if (!['/api/running', '/api/reviews/pending'].includes(pathname)) return originalFetch(...args);
      return Response.json({ projects: projects.map(group => ({ ...group,
        sessions: group.sessions.filter(s => pathname === '/api/running' ? s.running : !s.running),
      })) });
    };
    await Promise.all([refreshRunningConversations(), refreshPendingReviews()]);
    renderSessions();
  })()`);
  return page;
}

async function counts(page: Page, name: string): Promise<number[]> {
  return page.locator("#projectList .project-card", { hasText: name }).evaluate(card =>
    ["running", "review"].map(kind => Number(card.querySelector(`[data-testid="project-${kind}-badge"] .project-badge-count`)?.textContent || 0)));
}

test("project running and review badges follow the list's scheduled and done toggles", { timeout: 120_000 }, async t => {
  const page = await badgeFixture(t);
  const observed = [];
  for (const [done, scheduled] of [[false, false], [false, true], [true, true], [true, false], [false, false]]) {
    await page.locator("#showDoneConversations").setChecked(done);
    await page.locator("#showScheduledConversations").setChecked(scheduled);
    observed.push({
      badges: await counts(page, "Internal Assistant"),
      chips: await page.locator('#chatFilters [data-filter-count="active"], #chatFilters [data-filter-count="review"]').evaluateAll(elements => elements.map(e => Number(e.textContent))),
    });
  }
  assert.deepEqual(observed, [
    { badges: [1, 1], chips: [1, 1] },
    { badges: [2, 2], chips: [2, 2] },
    { badges: [4, 4], chips: [4, 4] },
    { badges: [2, 2], chips: [2, 2] },
    { badges: [1, 1], chips: [1, 1] },
  ], "project badges must exclude the same hidden conversations as the list");
  assert.equal(await page.getByTestId("pending-reviews-badge").textContent(), "8", "global inbox still includes hidden conversations");
  assert.equal(await page.getByTestId("running-conversations-open-button").locator("[data-running-count]").textContent(), "8", "global running list still includes hidden conversations");
});

test("unopened project badges use that project's saved visibility rather than the active project's toggles", { timeout: 120_000 }, async t => {
  const page = await badgeFixture(t);
  const observed = [await counts(page, "Joint Bob")];
  await page.locator("#showDoneConversations").check();
  await page.locator("#showScheduledConversations").check();
  observed.push(await counts(page, "Joint Bob"));
  for (const visibility of [{ done: false, scheduled: true }, { done: true, scheduled: true }, { done: true, scheduled: false }]) {
    await page.evaluate(async visibility => {
      const stateModule = "/app/state.js", projectsModule = "/app/project-list.js";
      const { state } = await import(stateModule);
      state.projectConversationVisibility[state.projects.find(p => p.name === "Joint Bob").id] = visibility;
      (await import(projectsModule)).renderProjects();
    }, visibility);
    observed.push(await counts(page, "Joint Bob"));
  }
  assert.deepEqual(observed, [[1, 1], [1, 1], [2, 2], [4, 4], [2, 2]], "snapshot-backed badges must honor each project's visibility settings");
});
