import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";

const MAC = "11111111-1111-4111-8111-111111111111";
const HOME = "22222222-2222-4222-8222-222222222222";
const EC2 = "33333333-3333-4333-8333-333333333333";
const NODES = { nodes: [{ id: MAC, name: "Mac", local: true, online: true }, { id: HOME, name: "Homeserver", local: false, online: true }, { id: EC2, name: "Contigos EC2", local: false, online: false }] };

function card(projectId: string, projectName: string, conversationId: string, title: string, column: string, executionNodeId: string | null) {
  return {
    projectId, projectName, conversationId, sessionId: conversationId, path: `/${conversationId}`, title, column, agentId: "claude", agentLabel: "Claude", agentModel: null,
    executionNodeId, updatedAt: "2026-11-05T10:00:00Z", turnRunning: column === "running", backgroundRunning: false, summary: null, autoRespondActive: false, startedBy: "you", pendingReviews: [], autoRespondStop: null,
  };
}

async function signIn(page: Page, url: string, environment: { username: string; password: string }): Promise<void> {
  await page.goto(url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length === 3 && !document.body.classList.contains("booting"));
  // Boot resets the view to the project list as its last step; open the control center only after that.
  await page.waitForFunction(async () => (await import("/app/state.js")).state.preferencesLoaded);
  await page.waitForTimeout(500);
}

test("a card can be picked, moved after its turn or stopped and moved now, and the batch is followed to its end", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment);
  const board = {
    projects: [{ id: "p1", name: "Joint Bob" }, { id: "p2", name: "DAK Live" }],
    cards: [
      card("p1", "Joint Bob", "c1", "Mobile menu", "running", null),
      card("p2", "DAK Live", "c2", "Slice 7", "needs-you", null),
      card("p1", "Joint Bob", "c3", "Review counter", "review", null),
      card("p2", "DAK Live", "c4", "Billing", "running", HOME),
    ],
  };
  await page.evaluate(`(() => {
    const originalFetch = window.fetch;
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    window.__moves = { requests: [], plans: [], polls: 0, cancels: 0 };
    const entry = (id, title, status, detail) => ({ projectId: 'p1', conversationId: id, title, projectName: 'Joint Bob', fromName: 'Mac', status, detail, stopped: false, continued: null });
    const job = (id, mode, finished) => ({ id, mode, targetId: ${JSON.stringify(HOME)}, targetName: 'Homeserver', startedAt: '2026-11-05T10:00:00Z', finishedAt: finished ? '2026-11-05T10:05:00Z' : null, cancelled: false,
      entries: id === 'j2' ? Array.from({ length: 8 }, (_, index) => entry('n' + index, 'Job ' + (index + 1), finished ? 'moved' : 'waiting', null))
        : [entry('c1', 'Mobile menu', finished ? 'moved' : 'waiting', finished ? 'Moved to Homeserver' : 'Moves when its current turn ends'), entry('c2', 'Slice 7', finished ? 'failed' : 'moving', finished ? 'Wait for the conversation transcript to synchronize to this node before taking ownership' : 'Moving to Homeserver')] });
    window.fetch = async (...args) => {
      const url = new URL(String(args[0]), location.href);
      const method = (args[1]?.method || 'GET').toUpperCase();
      if (url.pathname === '/api/control-center/board') return json(${JSON.stringify(board)});
      if (url.pathname === '/api/control-center/moves/nodes') return json(${JSON.stringify(NODES)});
      if (url.pathname === '/api/control-center/moves/plan') {
        const body = JSON.parse(args[1].body);
        window.__moves.plans.push(body);
        return json({ target: { id: body.target, name: 'Homeserver' }, entries: body.conversations.map((ref) => ref.conversationId === 'c2'
          ? { ...ref, title: 'Slice 7', projectName: 'DAK Live', from: 'Mac', turnRunning: true, verdict: 'cannot', reasons: ["Pi on Bedrock isn't set up on Homeserver"] }
          : { ...ref, title: 'Mobile menu', projectName: 'Joint Bob', from: 'Mac', turnRunning: true, verdict: 'ready', reasons: [] }) });
      }
      if (url.pathname === '/api/control-center/moves' && method === 'GET') return json({ jobs: [] });
      if (url.pathname === '/api/control-center/moves' && method === 'POST') {
        const body = JSON.parse(args[1].body);
        window.__moves.requests.push(body);
        return json({ job: job(body.mode === 'now' ? 'j2' : 'j1', body.mode, false) }, 202);
      }
      if (url.pathname === '/api/control-center/moves/j1/cancel') { window.__moves.cancels += 1; return json({ job: job('j1', 'after-turn', false) }); }
      if (url.pathname === '/api/control-center/moves/j1') { window.__moves.polls += 1; return json({ job: job('j1', 'after-turn', window.__moves.polls > 1) }); }
      if (url.pathname === '/api/control-center/moves/j2') return json({ job: job('j2', 'now', true) });
      return originalFetch(...args);
    };
  })()`);

  await page.getByTestId("projects-open-control-center-button").click();
  await page.waitForSelector('[data-testid="control-center-card"]');

  // Every card has Story and Overview, and the machines show how many agents run on each.
  assert.equal(await page.getByTestId("control-card-action-story").count(), 4);
  assert.equal(await page.getByTestId("control-card-action-overview").count(), 4);
  const nodes = page.getByTestId("control-moves-node");
  await nodes.first().waitFor();
  assert.deepEqual(await nodes.allTextContents(), ["Mac · 2 running Move all…", "Homeserver · 1 running Move all…"], "finished cards are not counted");
  assert.equal(await page.getByTestId("control-moves-bar").isHidden(), true);

  // Select puts a box on every card; picking by clicking the card does not open it.
  await page.getByTestId("control-board-tool-select").click();
  assert.equal(await page.getByTestId("control-moves-bar").isVisible(), true);
  assert.equal(await page.getByTestId("control-moves-pick").first().isVisible(), true);
  assert.equal(await page.getByTestId("control-moves-count").textContent(), "0 selected");
  assert.equal(await page.getByTestId("control-moves-later").isDisabled(), true);
  await page.locator('[data-key="p1:c1"] .control-title').click();
  await page.getByTestId("control-moves-preview").getByText("Every one of them can move.").waitFor();
  await page.locator('[data-key="p2:c2"] .control-title').click();
  // What cannot move is said before anything is pressed, with the reason from the machine it would move to.
  await page.waitForFunction(() => document.querySelector('[data-testid="control-moves-preview"]')?.textContent === "Can't move: Slice 7 (Pi on Bedrock isn't set up on Homeserver).");
  assert.equal(await page.locator("body.view-control").count(), 1, "picking did not open a conversation");
  assert.equal(await page.getByTestId("control-moves-count").textContent(), "2 selected");
  assert.equal(await page.locator('[data-key="p1:c1"]').evaluate((element) => element.classList.contains("control-picked")), true);
  assert.deepEqual(await page.getByTestId("control-moves-target").locator("option").allTextContents(), ["Mac", "Homeserver", "Contigos EC2 (offline)"]);
  assert.equal(await page.getByTestId("control-moves-target").inputValue(), HOME, "the first other machine that answers is the default");
  assert.match(await page.getByTestId("control-moves-now").getAttribute("title") ?? "", /tells it: "Continue where you stopped: you were moved from Mac to Homeserver\. Check what was half done before repeating anything\."/);

  // Move after the current turn: one request, then the batch is followed until it is over.
  await page.getByTestId("control-moves-later").click();
  const job = page.getByTestId("control-moves-job");
  await job.waitFor();
  const [first] = await page.evaluate("window.__moves.requests") as Array<{ target: string; mode: string; conversations: Array<{ projectId: string; conversationId: string }> }>;
  assert.deepEqual({ ...first, conversations: first.conversations.sort((a, b) => a.conversationId.localeCompare(b.conversationId)) }, { target: HOME, mode: "after-turn", conversations: [{ projectId: "p1", conversationId: "c1" }, { projectId: "p2", conversationId: "c2" }] });
  assert.equal(await page.getByTestId("control-moves-bar").isHidden(), true);
  assert.match(await job.textContent() ?? "", /Moving 2 to Homeserver/);
  assert.match(await page.locator('[data-testid="control-moves-entry"][data-status="waiting"]').textContent() ?? "", /Mobile menu.*Waiting for its turn to end: Moves when its current turn ends/);
  await page.getByTestId("control-moves-job-cancel").click();
  assert.equal(await page.evaluate("window.__moves.cancels"), 1);
  await page.waitForFunction(() => document.querySelector('[data-testid="control-moves-job"] b')?.textContent?.startsWith("Moved 1 of 2"));
  assert.match(await page.locator('[data-testid="control-moves-entry"][data-status="failed"]').textContent() ?? "", /Slice 7.*Failed: Wait for the conversation transcript to synchronize/);
  assert.equal(await page.getByTestId("control-moves-job-cancel").isHidden(), true, "nothing is left to stop waiting for");
  await page.getByTestId("control-moves-job-close").click();
  assert.equal(await job.isHidden(), true);

  // "Move all…" on a machine picks every unfinished agent there, and Stop and move now asks first.
  await page.getByTestId("control-moves-node").first().getByTestId("control-moves-all").click();
  assert.equal(await page.getByTestId("control-moves-count").textContent(), "2 selected");
  assert.equal(await page.locator('[data-key="p1:c3"]').evaluate((element) => element.classList.contains("control-picked")), false, "a finished conversation is not picked");
  assert.equal(await page.getByTestId("control-moves-target").inputValue(), HOME);
  await page.getByTestId("control-moves-now").click();
  await page.getByTestId("confirm-cancel-button").click();
  assert.equal((await page.evaluate("window.__moves.requests") as unknown[]).length, 1, "declining the confirmation sends nothing");
  await page.getByTestId("control-moves-now").click();
  assert.match(await page.locator("#confirmMessage").textContent() ?? "", /Stops the running turns of 2 conversations, moves them to Homeserver, then tells each one to continue/);
  await page.getByTestId("confirm-accept-button").click();
  await job.waitFor();
  assert.deepEqual((await page.evaluate("window.__moves.requests") as Array<{ mode: string }>).map((request) => request.mode), ["after-turn", "now"]);

  // A long batch is paged instead of scrolled.
  await page.waitForFunction(() => document.querySelector('[data-testid="control-moves-job"] b')?.textContent?.startsWith("Moved 8 of 8"));
  assert.equal(await page.getByTestId("control-moves-entry").count(), 5);
  await page.getByTestId("control-moves-job-next").click();
  assert.equal(await page.getByTestId("control-moves-entry").count(), 3);
  assert.equal(await page.getByTestId("control-moves-job-next").isDisabled(), true);
  await page.getByTestId("control-moves-job-close").click();

  // Leaving Select clears the boxes; the board is back to normal.
  await page.getByTestId("control-board-tool-select").click();
  await page.getByTestId("control-moves-cancel").click();
  assert.equal(await page.getByTestId("control-moves-bar").isHidden(), true);
  assert.equal(await page.locator(".control-board.selecting").count(), 0);
});

test("Story and Overview on a card open that conversation and use the app's own Story and Overview", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment);
  const target = await page.evaluate(async () => {
    const { projects } = await (await fetch("/api/projects")).json() as { projects: Array<{ id: string; name: string }> };
    for (const project of projects) {
      const { sessions } = await (await fetch(`/api/projects/${project.id}/sessions`)).json() as { sessions: Array<{ id: string; conversationId?: string; path: string; title: string }> };
      if (sessions.length) return { projectId: project.id, projectName: project.name, conversationId: sessions[0].conversationId ?? sessions[0].id, path: sessions[0].path, title: sessions[0].title };
    }
    throw new Error("The seeded node has no conversation");
  });
  const board = { projects: [{ id: target.projectId, name: target.projectName }], cards: [{ ...card(target.projectId, target.projectName, target.conversationId, target.title, "review", null), path: target.path }] };
  const seen: Array<{ url: string; body: unknown }> = [];
  // The voice is already chosen, and the writers answer with an error: this test is about what the card starts.
  await page.route("**/api/projects/*/git/**", (route) => {
    const request = route.request();
    seen.push({ url: request.url(), body: request.postDataJSON() });
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "writer unavailable in this test" }) });
  });
  await page.evaluate(`(() => {
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const path = new URL(String(args[0]), location.href).pathname;
      if (path === '/api/control-center/board') return new Response(JSON.stringify(${JSON.stringify(board)}), { status: 200, headers: { 'content-type': 'application/json' } });
      if (path === '/api/story-settings') return new Response(JSON.stringify({ settings: { voiceChosen: true, narrate: false, voiceProvider: 'kokoro', ask: false } }), { status: 200, headers: { 'content-type': 'application/json' } });
      return originalFetch(...args);
    };
  })()`);

  await page.getByTestId("projects-open-control-center-button").click();
  await page.waitForSelector('[data-testid="control-center-card"]');

  // Overview opens the card's conversation, then runs the Activity overview for it.
  await page.getByTestId("control-card-action-overview").click();
  await page.waitForFunction(() => document.body.classList.contains("view-control") && document.body.classList.contains("control-popup"));
  for (let attempt = 0; attempt < 100 && !seen.some((request) => request.url.includes("/git/overview")); attempt += 1) await page.waitForTimeout(100);
  const overview = seen.find((request) => request.url.includes("/git/overview"));
  assert.ok(overview, `the Activity overview was requested: ${JSON.stringify(seen.map((request) => request.url))}`);
  assert.equal((overview.body as { conversationId: string }).conversationId, target.conversationId);
  assert.equal(await page.evaluate(async () => (await import("/app/state.js")).state.activeProjectId), target.projectId);

  // Story opens the same conversation's story in the Git view.
  await page.evaluate(async () => (await import("/app/control-center.js")).closeConversationPopup());
  await page.waitForSelector('[data-testid="control-center-card"]');
  await page.getByTestId("control-card-action-story").click();
  await page.getByTestId("git-review-dialog").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("#gitReviewContext")?.textContent === "Conversation changes");
  assert.ok(seen.some((request) => request.url.includes("/git/story-latest") && request.url.includes(`conversationId=${encodeURIComponent(target.conversationId)}`)), `the saved story of that conversation was looked up: ${JSON.stringify(seen.map((request) => request.url))}`);
});
