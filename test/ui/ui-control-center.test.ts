import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

const BOARD = {
  projects: [{ id: "p1", name: "Joint Bob" }, { id: "p2", name: "DAK Live" }],
  cards: [
    { projectId: "p1", projectName: "Joint Bob", conversationId: "c1", sessionId: "c1", path: "/c1", title: "Mobile menu", column: "running", agentId: "claude", agentLabel: "Claude", agentModel: "sonnet", executionNodeId: null, updatedAt: "2026-11-05T10:00:00Z", turnRunning: true, backgroundRunning: false, summary: "Running the UI tests", autoRespondActive: true },
    { projectId: "p2", projectName: "DAK Live", conversationId: "c2", sessionId: "c2", path: "/c2", title: "Slice 7", column: "running", agentId: "pi", agentLabel: "Pi", agentModel: null, executionNodeId: null, updatedAt: "2026-11-05T09:00:00Z", turnRunning: true, backgroundRunning: false, summary: null, autoRespondActive: false },
    { projectId: "p1", projectName: "Joint Bob", conversationId: "c3", sessionId: "c3", path: "/c3", title: "Review counter", column: "review", agentId: "claude", agentLabel: "Claude", agentModel: null, executionNodeId: null, updatedAt: "2026-11-05T08:00:00Z", turnRunning: false, backgroundRunning: false, summary: "Fixed and tested", autoRespondActive: false },
  ],
};

test("the control center shows the live board, filters by project, colors cards and resets", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length === 3 && !document.body.classList.contains("booting"));
  // Boot resets the view to the project list as its last step; open the control center only after that.
  await page.waitForFunction(async () => (await import("/app/state.js")).state.preferencesLoaded);
  await page.waitForTimeout(500);
  await page.evaluate(`(() => {
    const originalFetch = window.fetch;
    window.__timeline = [{ id: 'old', role: 'system', text: 'Prod 5xx at 14%', via: null, projectId: 'p1', projectName: 'Joint Bob', importance: 'urgent', actions: [], createdAt: new Date().toISOString() },
      { id: 'rep', role: 'bob', text: 'Morning report', via: null, projectId: null, projectName: null, importance: 'report', actions: [], createdAt: new Date().toISOString() }];
    window.fetch = async (...args) => {
      const path = new URL(String(args[0]), location.href).pathname;
      if (path === '/api/control-center/bob/message') {
        const body = JSON.parse(args[1].body);
        window.__bobRequests = [...(window.__bobRequests || []), body];
        const started = body.message.startsWith('fix');
        const project = body.projectId === 'p2' ? { projectId: 'p2', projectName: 'DAK Live' } : started ? { projectId: 'p1', projectName: 'Joint Bob' } : { projectId: null, projectName: null };
        const make = (role, text, extra = {}) => ({ id: 'm' + window.__timeline.length, role, text, via: null, importance: 'fyi', actions: [], createdAt: new Date().toISOString(), ...project, ...extra });
        const user = make('user', body.message);
        window.__timeline.push(user);
        const reply = started
          ? make('bob', 'Started in ' + project.projectName + '. It is on the board now.', { via: 'Decision model 93% · task' })
          : make('bob', 'Two conversations are running.', { via: "Decision model 60% is under the threshold, so Bob's agent decided" });
        window.__timeline.push(reply);
        return new Response(JSON.stringify({ action: started ? 'started' : 'answer', user, reply, projectId: project.projectId }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path === '/api/control-center/bob/messages') {
        const query = new URL(String(args[0]), location.href).searchParams;
        const levels = { important: ['needs-ok', 'urgent', 'needs-you'], reports: ['report', 'done'], fyi: ['fyi'] }[query.get('importance')];
        const wanted = window.__timeline.filter((message) => (!levels || levels.includes(message.importance))
          && (!query.get('project') || (query.get('project') === 'general' ? !message.projectId : message.projectId === query.get('project'))));
        return new Response(JSON.stringify({ messages: wanted, waiting: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path !== '/api/control-center/board') return originalFetch(...args);
      return new Response(JSON.stringify(${JSON.stringify(BOARD)}), { status: 200, headers: { 'content-type': 'application/json' } });
    };
  })()`);

  await page.getByTestId("projects-open-control-center-button").click();
  await page.waitForSelector('[data-testid="control-center-card"]');
  assert.equal(await page.locator("body.view-control").count(), 1);
  assert.equal(await page.getByTestId("control-center-card").count(), 3);
  assert.equal(await page.getByTestId("control-center-count").textContent(), "2 running");
  assert.match(await page.locator('[data-key="p1:c1"]').textContent() ?? "", /Running the UI tests/);
  assert.match(await page.locator('[data-key="p1:c1"]').textContent() ?? "", /auto respond/);
  assert.match(await page.locator('[data-key="p2:c2"]').textContent() ?? "", /Working…/);
  assert.equal(await page.locator('[data-key="p1:c3"]').getAttribute("data-column"), "review");

  // Filter to one project.
  await page.getByTestId("control-center-filters").getByText("DAK Live").click();
  assert.equal(await page.getByTestId("control-center-card").count(), 1);
  await page.getByTestId("control-center-filters").getByText("All", { exact: true }).click();
  assert.equal(await page.getByTestId("control-center-card").count(), 3);

  // The whole card takes the picked color.
  await page.locator('[data-key="p1:c1"] [data-testid="control-center-color"]').evaluate((input: HTMLInputElement) => {
    input.value = "#ff6b9a";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.equal(await page.locator('[data-key="p1:c1"]').evaluate((card) => card.style.getPropertyValue("--card-color")), "#ff6b9a");
  assert.equal(await page.locator('[data-key="p1:c1"]').evaluate((card) => card.classList.contains("colored")), true);

  // Free layout positions cards absolutely; Reset puts everything back.
  await page.getByTestId("control-center-layout-free").click();
  assert.equal(await page.locator(".control-board.free").count(), 1);
  assert.equal(await page.locator('[data-key="p1:c1"]').evaluate((card) => getComputedStyle(card).position), "absolute");
  await page.getByTestId("control-center-reset").click();
  assert.equal(await page.locator(".control-board.free").count(), 0);
  assert.equal(await page.locator('[data-key="p1:c1"]').evaluate((card) => card.classList.contains("colored")), false);

  // Bob's chat keeps its timeline and labels every entry by project and by how much it matters.
  assert.match((await page.getByTestId("control-center-tabs").locator("button").allTextContents())[0], /^Live agents/, "the live board is the first tab");
  const entries = page.getByTestId("control-chat-entry");
  assert.equal(await entries.count(), 2);
  assert.match(await entries.first().innerText(), /Joint Bob[\s\S]*Urgent[\s\S]*Prod 5xx at 14%/);
  assert.match(await entries.nth(1).innerText(), /General[\s\S]*Report[\s\S]*Morning report/);

  await page.getByTestId("control-chat-input").fill("what is running?");
  await page.getByTestId("control-chat-send").click();
  await page.getByTestId("control-chat-messages").getByText("Two conversations are running.").waitFor();
  assert.match(await page.getByTestId("control-chat-messages").innerText(), /under the threshold, so Bob's agent decided/);
  await page.getByTestId("control-chat-project").selectOption({ label: "DAK Live" });
  await page.getByTestId("control-chat-input").fill("fix the slice 7 map");
  await page.keyboard.press("Enter");
  await page.getByTestId("control-chat-messages").getByText("Started in DAK Live.").waitFor();
  const requests = await page.evaluate("window.__bobRequests") as Array<{ message: string; projectId?: string }>;
  assert.deepEqual(requests.map((request) => request.projectId ?? null), [null, "p2"]);

  // The filters narrow the timeline by importance and by project.
  await page.getByTestId("control-chat-importance-important").click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="control-chat-entry"]').length === 1);
  assert.match(await page.getByTestId("control-chat-entry").innerText(), /Prod 5xx at 14%/);
  await page.getByTestId("control-chat-importance-reports").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="control-chat-entry"]')?.textContent?.includes("Morning report"));
  await page.getByTestId("control-chat-importance-all").click();
  await page.getByTestId("control-chat-filter-project").selectOption({ label: "DAK Live" });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="control-chat-entry"]').length === 2);
  await page.getByTestId("control-chat-filter-project").selectOption("");

  // Bob's settings are saved with the account; pausing shows a banner with a way back.
  await page.getByTestId("control-chat-settings-button").click();
  await page.getByTestId("control-bob-threshold").fill("75");
  await page.getByTestId("control-bob-threshold").dispatchEvent("change");
  await page.getByTestId("control-bob-ask").check();
  await page.waitForFunction(async () => {
    const saved = await (await fetch("/api/control-center/bob/settings")).json();
    return saved.threshold === 0.75 && saved.askBeforeSaving === true;
  });
  await page.getByTestId("control-chat-settings-button").click();
  await page.getByTestId("control-chat-monitor").click();
  await page.getByTestId("control-chat-paused").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("control-chat-monitor").textContent(), "Paused");
  await page.getByRole("button", { name: "Restore" }).click();
  await page.getByTestId("control-chat-paused").waitFor({ state: "hidden" });

  // The chat moves to the other side and is resized by its edge; both stay with the account.
  await page.getByTestId("control-chat-side").click();
  assert.equal(await page.locator(".control-main.chat-left").count(), 1);
  const handle = (await page.getByTestId("control-chat-resize").boundingBox())!;
  await page.mouse.move(handle.x + 3, handle.y + 100);
  await page.mouse.down();
  await page.mouse.move(handle.x + 203, handle.y + 100);
  await page.mouse.up();
  const width = await page.getByTestId("control-chat").evaluate((chat) => chat.getBoundingClientRect().width);
  assert.ok(width > 450, `dragging the edge widened the chat, got ${width}`);
  await page.waitForFunction(async () => {
    const saved = await (await fetch("/api/preferences")).json();
    return saved.controlCenter.chatSide === "left" && saved.controlCenter.chatWidth > 450;
  });

  // Exit and Esc both leave.
  await page.getByTestId("control-center-close-button").click();
  assert.equal(await page.locator("body.view-control").count(), 0);
  await page.getByTestId("projects-open-control-center-button").click();
  await page.waitForSelector('[data-testid="control-center-card"]');
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("body.view-control").count(), 0);
});
