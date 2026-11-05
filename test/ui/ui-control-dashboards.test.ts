import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { waitInPage } from "./wait-in-page.js";

/** A stand-in dashboard agent: the request's "Title: ..." line names the dashboard, "refresh with AI" makes it an AI one. */
const AGENT = `import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
export default async (input) => {
  if (input.prompt.startsWith("You are refreshing")) return JSON.stringify({ generatedAt: new Date().toISOString(), bugs: 99 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const request = input.prompt.split("## The person's request")[1] ?? "";
  const draft = /Draft folder \\(edit here\\): (.+)/.exec(input.prompt)[1].trim();
  await mkdir(draft, { recursive: true });
  const title = /Title: ([^\\n]+)/.exec(request)?.[1] ?? "Bugs";
  const ai = request.includes("refresh with AI");
  await writeFile(path.join(draft, "manifest.json"), JSON.stringify({ title, refresh: ai ? { method: "ai", prompt: "Count bugs" } : { method: "script", command: 'node "$JOINT_BOB_DASHBOARD_DIR/refresh.mjs"' } }));
  await writeFile(path.join(draft, "refresh.mjs"), "console.log(JSON.stringify({ generatedAt: new Date().toISOString(), bugs: 7 }))");
  await writeFile(path.join(draft, "index.html"), "<script>const data = JointBobKit.payload(); JointBobKit.mount(JointBobKit.kpi({ label: 'Bugs', value: data.bugs ?? 0 }))</script>");
  return "I built the dashboard.";
};
`;

type Fixture = Awaited<ReturnType<typeof nativeUiFixture>>;

/** Calls the app's own API from the page, signed in as the person. */
async function call(page: Page, method: string, route: string, body?: unknown): Promise<{ status: number; body: any }> {
  return page.evaluate(async ({ method, route, body }) => {
    const { state } = await import("/app/state.js");
    const response = await fetch(route, { method, headers: { "Content-Type": "application/json", "X-CSRF-Token": state.csrfToken }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, { method, route, body });
}

async function settled(page: Page, id: string, projectId: string): Promise<void> {
  await waitInPage(page, async ({ id, projectId }) => {
    const response = await fetch(`/api/dashboards/${id}?projectId=${projectId}`);
    return !(await response.json()).dashboard.running;
  }, { id, projectId }, 60_000);
}

/** Makes a dashboard the way the dashboards feature does: create, ask the agent, save, and (for a script one) refresh. */
async function makeDashboard(page: Page, entity: { kind: string; id: string }, hostProjectId: string, text: string, refresh: boolean): Promise<string> {
  const created = await call(page, "POST", "/api/dashboards", { entity, projectId: hostProjectId, ...(entity.kind === "workspace" ? { hostProjectId } : {}) });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.dashboard.id as string;
  assert.equal((await call(page, "POST", `/api/dashboards/${id}/messages`, { text, projectId: hostProjectId })).status, 202);
  await settled(page, id, hostProjectId);
  const saved = await call(page, "POST", `/api/dashboards/${id}/draft/save`, { projectId: hostProjectId });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  if (refresh) {
    assert.equal((await call(page, "POST", `/api/dashboards/${id}/refresh`, { target: "live", projectId: hostProjectId })).status, 202);
    await settled(page, id, hostProjectId);
  }
  return id;
}

function board(fixture: Fixture) {
  const [assistant, bob, infra] = ["Internal Assistant", "Joint Bob", "Infra Scripts"].map((name) => fixture.node.projects.find((project) => project.name === name)!);
  const card = (project: typeof assistant, id: string, title: string) => ({ projectId: project.id, projectName: project.name, conversationId: id, sessionId: id, path: `/${id}`, title, column: "running", agentId: "claude", agentLabel: "Claude", agentModel: null, executionNodeId: null, updatedAt: "2026-11-05T10:00:00Z", turnRunning: true, backgroundRunning: false, summary: "Working", autoRespondActive: false });
  return { projects: [assistant, bob, infra].map(({ id, name }) => ({ id, name })), cards: [card(assistant, "c1", "Assistant task"), card(bob, "c2", "Joint Bob task"), card(infra, "c3", "Infra task")] };
}

async function signedIn(t: test.TestContext) {
  const fixture = await nativeUiFixture(t, (root) => {
    const module = path.join(root, "dashboard-agent.mjs");
    writeFileSync(module, AGENT);
    return { JOINT_BOB_DASHBOARD_AGENT: module };
  });
  const { page, environment, node } = fixture;
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length === 3 && !document.body.classList.contains("booting"));
  await waitInPage(page, async () => (await import("/app/state.js")).state.preferencesLoaded);
  // Boot resets the view to the project list as its last step; open the control center only after that.
  await page.waitForTimeout(500);
  // With a project open the page listens for what the server announces, such as Bob's messages.
  await page.locator("#projectList .list-row").first().click();
  await waitInPage(page, async () => (await import("/app/state.js")).state.watchSocket?.readyState === 1);
  return fixture;
}

/** The board is a fixture; the dashboards, the chat and everything else are the real server's unless a test sets a stand-in. */
async function mockBoard(page: Page, boardBody: unknown): Promise<void> {
  await page.evaluate(`(() => {
    const originalFetch = window.fetch;
    const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    window.fetch = async (...args) => {
      const path = new URL(String(args[0]), location.href).pathname;
      if (path === '/api/control-center/board') return reply(${JSON.stringify(boardBody)});
      if (path === '/api/control-center/dashboards' && window.__dashboards) return reply({ dashboards: window.__dashboards });
      if (path === '/api/control-center/bob/messages' && window.__bobMessages) return reply({ messages: window.__bobMessages, waiting: 0 });
      if (path === '/api/control-center/bob/action' && window.__bobMessages) return reply({ messages: [] });
      return originalFetch(...args);
    };
  })()`);
}

test("the Dashboards tab lists dashboards, shows one over the board, and every board card has its project's dashboard button", { timeout: 240_000 }, async (t) => {
  const fixture = await signedIn(t);
  const { page } = fixture;
  const boardBody = board(fixture);
  const [assistant, bob, infra] = boardBody.projects;
  const assistantDashboard = await makeDashboard(page, { kind: "project", id: assistant.id }, assistant.id, "Show the bugs\nTitle: Bugs per day", true);
  await makeDashboard(page, { kind: "project", id: bob.id }, bob.id, "Judge the bugs, refresh with AI\nTitle: Judged bugs", false);
  await makeDashboard(page, { kind: "workspace", id: "personal" }, assistant.id, "What needs me\nTitle: My day", true);
  await mockBoard(page, boardBody);

  await page.getByTestId("projects-open-control-center-button").click();
  await page.waitForSelector('[data-testid="control-center-card"]');

  // Every board card has a dashboard button: the project's dashboard, or a way to ask Bob for one.
  await page.getByTestId("control-card-action-dashboard").first().waitFor();
  assert.equal(await page.locator('[data-key="' + `${assistant.id}:c1` + '"] [data-testid="control-card-action-dashboard"]').count(), 1);
  assert.equal(await page.locator('[data-key="' + `${bob.id}:c2` + '"] [data-testid="control-card-action-dashboard"]').count(), 1);
  assert.equal(await page.locator('[data-key="' + `${infra.id}:c3` + '"] [data-testid="control-card-action-dashboard"]').count(), 0, "a project without a dashboard has no button for one");
  const create = page.locator('[data-key="' + `${infra.id}:c3` + '"] [data-testid="control-card-action-dashboard-create"]');
  assert.equal(await page.locator('[data-testid="control-card-action-dashboard-create"]').count(), 1);

  // The create button puts the request in Bob's message box with the project chosen; the person finishes and sends it.
  await create.click();
  assert.equal(await page.getByTestId("control-chat-input").inputValue(), "Create a dashboard for Infra Scripts showing ");
  assert.equal(await page.getByTestId("control-chat-project").inputValue(), infra.id);
  assert.equal(await page.getByTestId("control-chat-input").evaluate((input) => document.activeElement === input), true);
  await page.getByTestId("control-chat-input").fill("");

  // One click on the project's dashboard button shows it over the board, with its data.
  await page.locator('[data-key="' + `${assistant.id}:c1` + '"] [data-testid="control-card-action-dashboard"]').click();
  const dialog = page.getByTestId("control-dashboard-dialog");
  await page.locator("dialog.control-dash-dialog[open]").waitFor();
  assert.equal(await page.getByTestId("control-dashboard-title").textContent(), "Bugs per day");
  const frame = page.getByTestId("control-dashboard-frame");
  assert.equal(await frame.getAttribute("sandbox"), "allow-scripts", "agent-written pages never get the app's origin");
  await page.frameLocator('[data-testid="control-dashboard-frame"]').getByText("7", { exact: true }).waitFor();
  assert.match(await page.getByTestId("control-dashboard-status").textContent() ?? "", /Refreshed .*Script, no AI/);
  assert.equal(await page.getByTestId("control-dashboard-refresh").textContent(), "Refresh");
  assert.equal(await page.getByTestId("control-dashboard-ai-note").count(), 0, "a script dashboard needs no AI warning");
  await page.getByTestId("control-dashboard-refresh").click();
  await page.waitForFunction(() => /Refreshed just now/.test(document.querySelector('[data-testid="control-dashboard-status"]')?.textContent ?? ""));
  assert.equal(await dialog.evaluate((node: HTMLDialogElement) => node.open), true);

  // Ask Bob to change it: the request goes to Bob's chat, the dashboard agent edits it, and Bob says so there.
  await page.getByTestId("control-dashboard-ask-bob").click();
  await page.getByTestId("control-dashboard-ask-text").fill("Rename it\nTitle: Bugs per week");
  await page.getByTestId("control-dashboard-ask-send").click();
  await page.waitForFunction(() => !document.querySelector("dialog.control-dash-dialog")?.hasAttribute("open"));
  await page.getByText("Bob is changing the dashboard.").waitFor();
  await page.getByTestId("control-chat-messages").getByText('Done. I changed "Bugs per week".').waitFor({ timeout: 60_000 });
  assert.match(await page.getByTestId("control-chat-messages").innerText(), /Change the dashboard "Bugs per day": Rename it/);
  assert.match(await page.getByTestId("control-chat-messages").innerText(), /Changing "Bugs per day"\./);
  assert.equal(await page.getByRole("button", { name: "Open dashboards" }).count(), 1);

  // The tab lists the dashboards in two groups, with the count on its tab.
  assert.match(await page.getByTestId("control-tab-dashboards").textContent() ?? "", /Dashboards\s*3/);
  await page.getByTestId("control-tab-dashboards").click();
  await page.waitForSelector('[data-testid="control-dashboard-card"]');
  assert.equal(await page.getByTestId("control-dashboard-card").count(), 3);
  assert.match(await page.getByTestId("control-dashboards-group-project").textContent() ?? "", /Projects 2/);
  assert.match(await page.getByTestId("control-dashboards-group-me").textContent() ?? "", /For me 1 · not tied to a project/);
  const scriptCard = page.locator(`[data-testid="control-dashboard-card"][data-id="${assistantDashboard}"]`);
  const text = await scriptCard.textContent() ?? "";
  assert.match(text, /Internal Assistant/);
  assert.match(text, /Bugs per week/, "the title Bob's change gave it");
  assert.match(text, /yours/);
  assert.match(text, /Refreshed (just now|\d+m ago)/);
  assert.match(text, /script · no AI/);
  const aiCard = page.getByTestId("control-dashboard-card").filter({ hasText: "Judged bugs" });
  assert.match(await aiCard.textContent() ?? "", /AI refresh · costs AI/);
  assert.match(await aiCard.textContent() ?? "", /Not refreshed yet/);
  assert.match(await page.getByTestId("control-dashboard-card").filter({ hasText: "My day" }).textContent() ?? "", /Workspace · Personal/);

  // One click on a card shows the dashboard. An AI dashboard says so and costs a click; its refresh shows its data.
  await aiCard.click();
  await page.locator("dialog.control-dash-dialog[open]").waitFor();
  assert.equal(await page.getByTestId("control-dashboard-refresh").textContent(), "Refresh with AI");
  assert.match(await page.getByTestId("control-dashboard-ai-note").textContent() ?? "", /uses AI/);
  assert.equal(await page.getByTestId("control-dashboard-refresh").getAttribute("title"), "Runs the dashboard agent once. This uses AI and costs tokens.");
  await page.getByTestId("control-dashboard-refresh").click();
  await page.frameLocator('[data-testid="control-dashboard-frame"]').getByText("99", { exact: true }).waitFor();
  await page.getByTestId("control-dashboard-full").click();
  await page.locator("#dashboardDialog[open]").waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="dashboard-title"]')?.textContent === "Joint Bob");
  assert.match(await page.getByTestId("dashboard-status").textContent() ?? "", /AI refresh/, "the full view is the existing dashboard view of the same dashboard");
  await page.getByTestId("dashboard-close").click();

  // The board's project filter applies: a project's dashboards, and the personal ones whose workspace holds the project.
  await page.getByTestId("control-tab-live").click();
  await page.getByTestId("control-center-filters").getByText("Infra Scripts").click();
  await page.getByTestId("control-tab-dashboards").click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="control-dashboard-card"]').length === 1);
  assert.match(await page.getByTestId("control-dashboard-card").textContent() ?? "", /My day/, "Infra Scripts has no dashboard of its own; the personal one covers it");
  assert.match(await page.getByTestId("control-tab-dashboards").textContent() ?? "", /Dashboards\s*1/);
  await page.getByTestId("control-tab-live").click();
  await page.getByTestId("control-center-filters").getByText("Joint Bob").click();
  await page.getByTestId("control-tab-dashboards").click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="control-dashboard-card"]').length === 2);
  assert.equal(await page.getByTestId("control-dashboard-card").filter({ hasText: "Bugs per week" }).count(), 0, "Internal Assistant's dashboard is not in the filter");
  await page.getByTestId("control-tab-live").click();
  await page.getByTestId("control-center-filters").getByText("All", { exact: true }).click();
});

test("the Dashboards tab pages instead of scrolling, labels what Bob made, and Bob's Open dashboards button opens it", { timeout: 120_000 }, async (t) => {
  const fixture = await signedIn(t);
  const { page } = fixture;
  const boardBody = board(fixture);
  await mockBoard(page, boardBody);
  const card = (index: number, group: "project" | "me", extra: Record<string, unknown> = {}) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, title: `Dashboard ${index}`, group, entity: { kind: group === "project" ? "project" : "workspace", id: boardBody.projects[0].id },
    hostProjectId: boardBody.projects[0].id, projectId: group === "project" ? boardBody.projects[0].id : null, projectName: group === "project" ? "Internal Assistant" : null,
    workspaceLabel: group === "me" ? "Personal" : null, projectIds: group === "me" ? [boardBody.projects[0].id] : [], madeBy: index % 2 ? "bob" : "you", origin: "own", ownerNodeId: "n",
    refreshMethod: index % 3 ? "script" : "ai", status: "ready", approved: true, lastRefresh: { at: new Date().toISOString(), ok: true, error: null }, publishedAt: null, changing: false, canChange: true,
    updatedAt: `2026-11-05T10:${String(index).padStart(2, "0")}:00Z`, ...extra,
  });
  const many = [
    ...Array.from({ length: 22 }, (_, index) => card(index + 1, "project")),
    ...Array.from({ length: 5 }, (_, index) => card(index + 40, "me")),
    card(70, "project", { status: "building", title: "Being built", refreshMethod: null, lastRefresh: null, canChange: false }),
    card(71, "project", { status: "draft", title: "Never finished", refreshMethod: null, lastRefresh: null, canChange: false }),
    card(72, "project", { title: "Shared one", madeBy: "shared", origin: "received", approved: false, canChange: false, lastRefresh: null }),
    card(73, "project", { title: "Failing one", lastRefresh: { at: new Date().toISOString(), ok: false, error: "boom" } }),
  ];
  await page.evaluate((cards) => { (window as any).__dashboards = cards; }, many);
  await page.getByTestId("projects-open-control-center-button").click();
  await page.waitForSelector('[data-testid="control-center-card"]');
  await page.getByTestId("control-tab-dashboards").click();
  await page.waitForSelector('[data-testid="control-dashboard-card"]');
  assert.match(await page.getByTestId("control-tab-dashboards").textContent() ?? "", /Dashboards\s*31/);

  // The list fits the height and pages: nothing scrolls, and each page holds only what fits.
  const fits = async () => page.getByTestId("control-dashboards-list").evaluate((list) => ({ scrolls: list.scrollHeight > list.clientHeight + 1, cards: list.querySelectorAll('[data-testid="control-dashboard-card"]').length }));
  const first = await fits();
  assert.equal(first.scrolls, false, "the first page does not scroll");
  assert.ok(first.cards > 0 && first.cards < 31, `a page holds some of the 31, got ${first.cards}`);
  const label = await page.getByTestId("control-dashboards-page-label").textContent();
  const pages = Number(/of (\d+)/.exec(label ?? "")![1]);
  assert.ok(pages > 1);
  assert.equal(await page.getByTestId("control-dashboards-prev").isDisabled(), true);
  let seen = first.cards;
  for (let index = 1; index < pages; index += 1) {
    await page.getByTestId("control-dashboards-next").click();
    const next = await fits();
    assert.equal(next.scrolls, false, `page ${index + 1} does not scroll`);
    seen += next.cards;
  }
  assert.equal(seen, 31, "every dashboard is on one page");
  assert.equal(await page.getByTestId("control-dashboards-next").isDisabled(), true);
  for (let index = 1; index < pages; index += 1) await page.getByTestId("control-dashboards-prev").click();

  // Less height, fewer fit: the page size follows the room.
  await page.setViewportSize({ width: 1440, height: 640 });
  await page.waitForFunction((was) => document.querySelectorAll('[data-testid="control-dashboard-card"]').length < was, first.cards);
  assert.equal((await fits()).scrolls, false);
  await page.setViewportSize({ width: 1440, height: 900 });

  // A project filter that matches nothing says so.
  await page.getByTestId("control-tab-live").click();
  await page.getByTestId("control-center-filters").getByText("Infra Scripts").click();
  await page.getByTestId("control-tab-dashboards").click();
  await page.getByTestId("control-dashboards-empty").waitFor();
  assert.match(await page.getByTestId("control-dashboards-empty").textContent() ?? "", /Nothing matches the project filter\./);
  assert.match(await page.getByTestId("control-tab-dashboards").textContent() ?? "", /Dashboards$/, "no count when nothing shows");
  await page.getByTestId("control-tab-live").click();
  await page.getByTestId("control-center-filters").getByText("All", { exact: true }).click();

  // What Bob made says so, and what is unfinished or needs approval says that.
  await page.evaluate(() => { (window as any).__dashboards = (window as any).__dashboards.filter((card: { id: string }) => /0(01|02|70|71|72|73)$/.test(card.id)); });
  await page.setViewportSize({ width: 1440, height: 1700 });
  await page.getByTestId("control-tab-dashboards").click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="control-dashboard-card"]').length === 6);
  const byTitle = (title: string) => page.getByTestId("control-dashboard-card").filter({ hasText: title });
  assert.match(await byTitle("Dashboard 1").textContent() ?? "", /made by Bob/);
  assert.match(await byTitle("Dashboard 2").textContent() ?? "", /yours/);
  assert.match(await byTitle("Being built").textContent() ?? "", /Bob is building it…/);
  assert.match(await byTitle("Never finished").textContent() ?? "", /Not finished\. Open it to carry on\./);
  assert.match(await byTitle("Shared one").textContent() ?? "", /shared with you[\s\S]*Waiting for your approval/);
  assert.match(await byTitle("Failing one").textContent() ?? "", /The last refresh failed/);

  // Bob's message that a dashboard is ready has a button that moves to this tab.
  await page.getByTestId("control-tab-live").click();
  await page.evaluate(() => {
    (window as any).__bobMessages = [{ id: "m1", role: "bob", text: 'Done. "Dashboard 1" is ready for "Internal Assistant".', via: "Dashboards · script refresh, no AI", projectId: null, projectName: null, importance: "done", actions: [{ id: "dashboards.open", label: "Open dashboards", style: "primary", data: { dashboardId: "x" } }], createdAt: new Date().toISOString() }];
    window.dispatchEvent(new CustomEvent("control-center-changed"));
  });
  await page.getByRole("button", { name: "Open dashboards" }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="control-tab-dashboards"]')?.classList.contains("active"));
  assert.equal(await page.getByTestId("control-dashboard-card").first().isVisible(), true);
});
