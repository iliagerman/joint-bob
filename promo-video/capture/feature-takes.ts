// The takes behind the feature films that explain one feature each, like the takes in takes.ts.
//
//   pools       three Claude accounts in a failover pool, used by default, and the failover test
//   budgets     spend limits for a cluster, a project and a conversation; a warning, then a stop
//   guardian    Guardian switched on; a delete paused for the person, a key removed from a message
//   dashboards  a dashboard described in words, built by the dashboard agent, tested and saved
//   assistant   a release assistant: how a feature is going, a meeting booked, a launch scheduled from a
//               phone for Monday at six, and the launch run reporting in the same chat
//   phone       the app installed on a phone, a conversation picked up and continued from it
//   story       a conversation's written story, its Overview podcast, and a follow-up question
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator, Page, Route } from "playwright-core";
import { api, signIn, type PromoNode } from "./env.js";
import { glideClick, openConversation, openStage, record, tap } from "./browser.js";
import { answer, ask, closeSettings, desktop, formTeam, newConversation, now, phone, sleep, type, type Kit } from "./takes.js";
import { followUpQuestion, podcastScript, podcastWithAnswer, speakStoryLines, spokenLines, storyFacts, storyPatches, storyWritten } from "./story-fixture.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const audioDir = path.resolve(here, "../public/audio");

/** Brings an element to the middle of its scrolling panel, the way a reader would scroll to it. */
async function bringIntoView(page: Page, selector: string, ms = 700): Promise<void> {
  await page.locator(selector).first().evaluate((element) => element.scrollIntoView({ behavior: "smooth", block: "center" }));
  await sleep(ms);
}

/** Chooses an option in one of the app's searchable pickers, typed the way a person would. */
async function pick(page: Page, scope: string, testid: string, search: string, label = search): Promise<void> {
  const control = `${scope} [data-testid="${testid}"]`.trim();
  await glideClick(page, control, { ms: 340 });
  await page.locator(`${scope} [data-testid="${testid}-search"]`.trim()).first().pressSequentially(search, { delay: 30 });
  await sleep(250);
  const option = page.locator(`${scope} [data-testid="${testid}-option"]`.trim()).filter({ hasText: label }).first();
  const box = await option.boundingBox();
  if (box) await glideClick(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, { ms: 260 });
  else await option.click();
}

async function openSettingsTab(page: Page, tab: string): Promise<void> {
  await glideClick(page, '[data-testid="settings-open-button"]', { ms: 420 });
  await page.locator("#settingsDialog[open]").waitFor();
  await sleep(300);
  await glideClick(page, `#settingsTab-${tab}`, { ms: 380 });
}

async function sessionsOf(node: PromoNode, session: Awaited<ReturnType<typeof signIn>>, projectId: string): Promise<Array<{ id: string; conversationId?: string; title?: string; name?: string }>> {
  const listed = await api<{ sessions: Array<{ id: string; conversationId?: string; title?: string; name?: string }> }>(node, session, "GET", `/projects/${projectId}/sessions`);
  return listed.body.sessions ?? [];
}

const titled = (sessions: Array<{ title?: string; name?: string }>, title: string) => sessions.find((item) => `${item.title ?? ""} ${item.name ?? ""}`.includes(title));

/* ---------- Subscription pools ---------- */

async function pools({ environment, browser, root, finish, openProject }: Kit): Promise<void> {
  const [laptopNode] = environment.nodes;
  const { page } = await openStage(browser, environment, laptopNode, desktop);
  await openProject(page, "checkout-api");
  const events: Record<string, number> = {};
  const recording = await record(page, root, "pools");
  await sleep(600);
  // Settings → Connections: one profile for each Claude account, then a pool of them.
  await openSettingsTab(page, "connections");
  await page.getByTestId("provider-profile-add").waitFor();
  events.settings = now();
  await sleep(900);

  const addProfile = async (label: string) => {
    await glideClick(page, '[data-testid="provider-profile-provider-claude"]', { ms: 320 });
    await type(page, '[data-testid="provider-profile-label"]', label, 34);
    await glideClick(page, '[data-testid="provider-profile-add"]', { ms: 300 });
    await page.getByTestId("provider-profile-row").filter({ hasText: label }).waitFor();
    await sleep(500);
  };
  const accounts = ["Claude account 1", "Claude account 2", "Claude account 3"];
  await addProfile(accounts[0]);
  events.profile = now();
  await addProfile(accounts[1]);
  await addProfile(accounts[2]);
  events.profiles = now();
  await sleep(900);

  await glideClick(page, '[data-testid="provider-profiles-tab-pools"]', { ms: 380 });
  await sleep(500);
  await glideClick(page, '[data-testid="subscription-pool-new"]', { ms: 360 });
  await page.getByTestId("subscription-pool-name").waitFor();
  events.poolForm = now();
  await type(page, '[data-testid="subscription-pool-name"]', "Claude accounts", 40);
  for (const [index, label] of accounts.entries()) {
    if (index > 0) await glideClick(page, '[data-testid="subscription-pool-member-add"]', { ms: 300 });
    await pick(page, "", `subscription-pool-member-${index}`, label.slice(-9), label);
    await sleep(300);
  }
  await sleep(500);
  await glideClick(page, '[data-testid="subscription-pool-save"]', { ms: 340 });
  await page.getByTestId("subscription-pool-card").filter({ hasText: "Claude accounts" }).waitFor();
  events.pool = now();
  await sleep(1400);

  // Where it applies: the default for every project.
  await glideClick(page, '[data-testid="provider-profiles-tab-assignments"]', { ms: 380 });
  await page.getByTestId("provider-assignment-default-select").waitFor();
  events.assign = now();
  await sleep(600);
  await pick(page, "", "provider-assignment-default-select", "Claude acc", "Claude accounts");
  await page.locator("#confirmDialog[open]").waitFor();
  await sleep(700);
  await glideClick(page, '[data-testid="confirm-accept-button"]', { ms: 320 });
  await page.waitForFunction(() => document.querySelector('[data-testid="provider-assignment-default-select"]')?.textContent?.includes("Claude accounts"));
  events.assigned = now();
  await sleep(1400);

  // Test it: the first account runs out, and the next one takes over.
  await glideClick(page, '[data-testid="provider-profiles-tab-pools"]', { ms: 380 });
  const card = page.getByTestId("subscription-pool-card").filter({ hasText: "Claude accounts" });
  await card.waitFor();
  await sleep(500);
  const test = await card.getByTestId("subscription-pool-test").boundingBox();
  await glideClick(page, { x: test!.x + test!.width / 2, y: test!.y + test!.height / 2 }, { ms: 380 });
  await page.getByTestId("subscription-pool-simulation-model").waitFor();
  await pick(page, "", "subscription-pool-simulation-model", "Claude", "Claude");
  const result = page.getByTestId("subscription-pool-simulation-result");
  await result.filter({ hasText: accounts[0] }).waitFor();
  events.simulation = now();
  await sleep(1600);
  const press = async (index: number) => {
    const member = await page.getByTestId("subscription-pool-simulation-cards").locator("button").nth(index).boundingBox();
    await glideClick(page, { x: member!.x + member!.width / 2, y: member!.y + member!.height / 2 }, { ms: 420 });
  };
  await press(0);
  await result.filter({ hasText: accounts[1] }).waitFor();
  events.failover = now();
  await sleep(2200);
  await press(1);
  await result.filter({ hasText: accounts[2] }).waitFor();
  events.secondFailover = now();
  await sleep(2600);
  await finish("pools", recording, events);
}

/* ---------- Spend budgets ---------- */

async function budgets({ environment, browser, root, finish, openProject }: Kit): Promise<void> {
  const [laptopNode, serverNode, teammateNode] = environment.nodes;
  const { projectId } = await formTeam(environment, [serverNode, teammateNode], "checkout-api");
  const owner = await signIn(environment, laptopNode);
  const sessions = await sessionsOf(laptopNode, owner, projectId);
  const migration = titled(sessions, "Payment provider migration");
  const fraud = titled(sessions, "Fraud rule tuning");
  if (!migration || !fraud) throw new Error(`Seeded conversations missing: ${sessions.map((item) => item.title ?? item.name).join(", ")}`);
  const conversationOf = (item: { id: string; conversationId?: string }) => item.conversationId ?? item.id;
  // What each conversation has already cost, read the way the app reads it: through a limit.
  const spent = async (conversationId: string): Promise<number> => {
    const subject = `kind=conversation&subjectId=${encodeURIComponent(conversationId)}&projectId=${encodeURIComponent(projectId)}`;
    await api(laptopNode, owner, "PUT", `/budgets/limits?${subject}`, { limits: [{ period: "total", usd: 1_000_000 }], utcOffsetMinutes: 0 });
    const status = await api<{ budgets: Array<{ kind: string; period: string; spentUsd: number }> }>(laptopNode, owner, "GET", `/budgets/status?projectId=${projectId}&conversationId=${encodeURIComponent(conversationId)}`);
    await api(laptopNode, owner, "PUT", `/budgets/limits?${subject}`, { limits: [], utcOffsetMinutes: 0 });
    return status.body.budgets.find((budget) => budget.kind === "conversation" && budget.period === "total")?.spentUsd ?? 0;
  };
  const migrationSpent = await spent(conversationOf(migration));
  const fraudSpent = await spent(conversationOf(fraud));
  console.log(`spent: migration $${migrationSpent.toFixed(2)}, fraud $${fraudSpent.toFixed(2)}`);
  // The second conversation is already over its own limit, set before the film starts.
  const fraudSubject = `kind=conversation&subjectId=${encodeURIComponent(conversationOf(fraud))}&projectId=${encodeURIComponent(projectId)}`;
  await api(laptopNode, owner, "PUT", `/budgets/limits?${fraudSubject}`, { limits: [{ period: "total", usd: Math.max(0.5, Math.floor(fraudSpent * 0.9 * 100) / 100) }], utcOffsetMinutes: 0 });

  const { page } = await openStage(browser, environment, laptopNode, desktop);
  await openProject(page, "checkout-api");
  const events: Record<string, number> = {};
  const recording = await record(page, root, "budgets");
  await sleep(600);

  // The cluster's manager sets the limits for everything shared into the cluster.
  await openSettingsTab(page, "cluster");
  await page.getByTestId("cluster-item").first().waitFor();
  await glideClick(page, '[data-testid="cluster-item"]', { ms: 360 });
  await glideClick(page, '[data-testid="cluster-tab-budget"]', { ms: 360 });
  await page.getByTestId("cluster-budget-grid").waitFor();
  events.cluster = now();
  await sleep(900);
  const cell = (row: string, period: string) => `[data-budget-row="${row}"][data-budget-period="${period}"]`;
  await type(page, cell("limits", "month"), "500", 90);
  await type(page, cell("project", "month"), "150", 90);
  await type(page, cell("conversation", "day"), "20", 90);
  events.typed = now();
  await sleep(500);
  await glideClick(page, '[data-testid="cluster-budget-save"]', { ms: 340 });
  await page.getByTestId("cluster-budget").filter({ hasText: "Revision 1" }).waitFor();
  events.clusterSaved = now();
  await sleep(1600);
  await glideClick(page, closeSettings, { ms: 380 });
  await page.locator("#settingsDialog[open]").waitFor({ state: "detached" }).catch(() => {});
  await sleep(500);

  // An owner adds a tighter limit to their own project.
  await glideClick(page, `[data-project-id="${projectId}"] [data-testid="project-menu-button"]`, { ms: 380 });
  await glideClick(page, '[data-testid="project-budget-button"]', { ms: 320 });
  await page.getByTestId("budget-dialog").waitFor();
  events.project = now();
  await sleep(700);
  await type(page, '[data-testid="budget-dialog"] [data-budget-period="day"]', "25", 90);
  await sleep(400);
  await glideClick(page, '[data-testid="budget-dialog-save"]', { ms: 320 });
  await page.getByTestId("budget-dialog").waitFor({ state: "hidden" });
  events.projectSaved = now();
  await sleep(900);

  // A conversation near its limit: the warning sits above the message box.
  const migrationRow = '#sessionList .list-row:has-text("Payment provider migration")';
  await openConversation(page, migrationRow, "Payment provider migration");
  await sleep(800);
  await glideClick(page, `${migrationRow} [data-testid="session-menu-button"]`, { ms: 360 });
  await glideClick(page, '[data-testid="session-budget-button"]', { ms: 320 });
  await page.getByTestId("budget-dialog").waitFor();
  events.conversation = now();
  await sleep(600);
  const limit = Math.ceil((migrationSpent / 0.86) * 100) / 100;
  await type(page, '[data-testid="budget-dialog"] [data-budget-period="total"]', limit.toFixed(2), 90);
  await sleep(400);
  await glideClick(page, '[data-testid="budget-dialog-save"]', { ms: 320 });
  await page.getByTestId("budget-dialog").waitFor({ state: "hidden" });
  await page.locator('[data-testid="budget-notice"][data-state="warning"]').waitFor({ timeout: 20_000 });
  events.warning = now();
  await sleep(2600);

  // A conversation over its limit: new work does not start.
  const fraudRow = '#sessionList .list-row:has-text("Fraud rule tuning")';
  await openConversation(page, fraudRow, "Fraud rule tuning");
  await page.locator('[data-testid="budget-notice"][data-state="over"]').waitFor({ timeout: 20_000 });
  events.over = now();
  await sleep(1400);
  await ask(page, "Tune the rules for the new card network too.", 22);
  events.sent = now();
  await sleep(3600);
  await finish("budgets", recording, events);
}

/* ---------- Guardian ---------- */

/**
 * A stand-in for the decision model Guardian asks, answering like Laya's `/v1/systemone`: a high
 * "yes" for a rule only when the content plainly matches it, and a low one otherwise.
 */
export function startDecisionModel(): Promise<Server> {
  const yes: Record<string, RegExp> = {
    "dangerous-commands": /rm -rf|DROP TABLE|truncate /i,
    secrets: /sk_live_[A-Za-z0-9]{8,}|AKIA[A-Z0-9]{12,}|ghp_[A-Za-z0-9]{20,}/,
    "personal-information": /\b\d{3}-\d{2}-\d{4}\b/,
  };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const { state = "", questions = {} } = JSON.parse(body || "{}") as { state?: string; questions?: Record<string, unknown> };
      const answers = Object.fromEntries(Object.keys(questions).map((id) => [id, { noul: yes[id]?.test(state) ? 0.94 : 0.03 }]));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ answers }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function guardian({ environment, browser, root, finish, openProject }: Kit): Promise<void> {
  const [laptopNode] = environment.nodes;
  const model = await startDecisionModel();
  try {
    const admin = await signIn(environment, laptopNode);
    const current = await api<{ settings: Record<string, unknown> }>(laptopNode, admin, "GET", "/guardian");
    const configured = await api(laptopNode, admin, "PUT", "/guardian", { settings: { ...current.body.settings, enabled: false, model: "laya-remote", layaUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}` } });
    if (configured.status !== 200) throw new Error(`Guardian settings refused: ${JSON.stringify(configured.body)}`);

    const { page } = await openStage(browser, environment, laptopNode, desktop);
    // Staged: the socket's "ready" message can arrive with no open reviews while one is waiting
    // (a bug in conversation ids, reported separately), which takes the card away. Until it is
    // answered, the card the page was shown stays.
    await page.addInitScript(() => {
      let waiting: unknown = null;
      document.addEventListener("guardian-event", (event) => {
        const detail = (event as CustomEvent).detail as { type: string; reviews?: unknown[] };
        if (detail.type !== "guardianReviews") return;
        if (detail.reviews?.length) waiting = detail;
        else if (waiting) event.stopImmediatePropagation();
      }, true);
      // A re-render of the chat area can also drop the card; the page is handed the same review again.
      setInterval(() => {
        if (waiting && !document.querySelector('[data-testid="guardian-review"]')) document.dispatchEvent(new CustomEvent("guardian-event", { detail: waiting }));
      }, 200);
      document.addEventListener("click", (event) => {
        if ((event.target as Element).closest?.('[data-testid="guardian-review-block"], [data-testid="guardian-review-allow"]')) {
          waiting = null;
          setTimeout(() => document.querySelector('[data-testid="guardian-review"]')?.remove(), 600);
        }
      }, true);
    });
    await page.reload();
    await openProject(page, "checkout-api");
    const events: Record<string, number> = {};
    const recording = await record(page, root, "guardian");
    await sleep(600);
    await openSettingsTab(page, "guardian");
    await page.getByTestId("guardian-enabled").waitFor();
    events.settings = now();
    await sleep(1200);
    await glideClick(page, '[data-testid="guardian-enabled"]', { ms: 340 });
    await page.waitForFunction(async () => (await (await fetch("/api/guardian")).json()).settings.enabled === true);
    events.enabled = now();
    await sleep(1400);
    await glideClick(page, '[data-testid="guardian-rule"]:first-child [data-testid="guardian-rule-edit"]', { ms: 380 });
    await page.getByTestId("guardian-rule-editor").waitFor();
    events.editor = now();
    await sleep(3200);
    await glideClick(page, '[data-testid="guardian-rule-cancel"]', { ms: 340 });
    await sleep(500);
    await glideClick(page, closeSettings, { ms: 380 });
    await page.locator("#settingsDialog[open]").waitFor({ state: "detached" }).catch(() => {});
    await sleep(400);

    // A delete is paused until the person answers.
    await newConversation(page, "Release clean-up");
    // Guardian files a pause under the app's conversation once the conversation has its record,
    // which it gets with its first turn (see the note in the report).
    await page.locator("#messageInput").fill("Get the release branch ready.");
    await page.locator("#sendButton").click();
    await answer(page, "On it").waitFor({ timeout: 60_000 });
    // Reopened, the page talks to the conversation under the id its record now has.
    await sleep(1500);
    await page.reload();
    await openProject(page, "checkout-api");
    await openConversation(page, '#sessionList .list-row:has-text("Release clean-up")', "Release clean-up");
    await sleep(1200);
    events.conversation = now();
    await ask(page, "Delete the old customer exports before the release.", 22);
    await page.getByTestId("guardian-review").waitFor({ timeout: 60_000 });
    events.review = now();
    await sleep(3200);
    await glideClick(page, '[data-testid="guardian-review-block"]', { ms: 420 });
    events.blocked = now();
    await answer(page, "Nothing was deleted").waitFor({ timeout: 60_000 });
    events.archived = now();
    await sleep(2200);

    // A live key in a message is removed before the model sees it.
    await answer(page, "Nothing was deleted").waitFor();
    await sleep(1500);
    await ask(page, "Check the deploy status on staging with this key: AKIA4QWERTYZX7PLMN2B", 20);
    events.secret = now();
    await answer(page, "tasks healthy").waitFor({ timeout: 60_000 });
    events.secretAnswered = now();
    await sleep(2600);
    await finish("guardian", recording, events);
  } finally {
    model.close();
  }
}

/* ---------- Dashboards ---------- */

async function dashboards({ environment, browser, root, finish, openProject }: Kit): Promise<void> {
  const [laptopNode] = environment.nodes;
  const projectId = laptopNode.projects.find((project) => project.name === "checkout-api")!.id;
  const { page } = await openStage(browser, environment, laptopNode, desktop);
  await openProject(page, "checkout-api");
  const events: Record<string, number> = {};
  const recording = await record(page, root, "dashboards");
  await sleep(700);
  await glideClick(page, `[data-project-id="${projectId}"] [data-testid="project-menu-button"]`, { ms: 380 });
  await glideClick(page, '[data-testid="project-dashboard-button"]', { ms: 320 });
  await page.getByTestId("dashboard-empty").waitFor();
  events.empty = now();
  await sleep(900);
  await type(page, '[data-testid="dashboard-request"]', "Checkout errors per hour, the top errors, and anything we have never seen before.", 18);
  events.typed = now();
  await sleep(500);
  await glideClick(page, '[data-testid="dashboard-create"]', { ms: 340 });
  await page.getByTestId("dashboard-creator").waitFor();
  events.building = now();
  await page.getByTestId("dashboard-draft-frame").waitFor({ timeout: 60_000 });
  events.preview = now();
  await page.getByText("I built", { exact: false }).first().waitFor({ timeout: 60_000 });
  events.built = now();
  await sleep(2200);
  await glideClick(page, '[data-testid="dashboard-test-refresh"]', { ms: 360 });
  await sleep(3000);
  events.tested = now();
  await glideClick(page, '[data-testid="dashboard-save"]', { ms: 360 });
  await page.getByTestId("dashboard-frame").waitFor({ timeout: 30_000 });
  events.saved = now();
  await sleep(3600);
  await glideClick(page, '[data-testid="dashboard-refresh"]', { ms: 380 });
  events.refresh = now();
  await sleep(3400);
  await finish("dashboards", recording, events);
}

/* ---------- Release assistant ---------- */

/** Presses something on a page or inside a frame on it: a glide and a click, or a tap on a phone. */
async function press(page: Page, target: Locator, touch: boolean): Promise<void> {
  await target.waitFor();
  await target.scrollIntoViewIfNeeded().catch(() => {});
  await sleep(150);
  const box = await target.boundingBox();
  if (!box) throw new Error("Nothing to press");
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  if (touch) await page.touchscreen.tap(point.x, point.y);
  else await glideClick(page, point, { ms: 340 });
}
async function write(page: Page, target: Locator, text: string, delay: number, touch: boolean): Promise<void> {
  await press(page, target, touch);
  await target.pressSequentially(text, { delay });
}

/** Sends a message in the assistant's chat and waits for the reply that contains `reply`. */
async function chat(page: Page, message: string, reply: string, touch: boolean): Promise<void> {
  await write(page, page.locator("#chat-message"), message, touch ? 30 : 24, touch);
  await sleep(300);
  await press(page, page.locator("#chat-form button"), touch);
  // The page says so when a turn fails; that is a reason to stop, not to wait.
  const failed = page.locator("#message.danger");
  await Promise.race([page.locator("#timeline .chat-bubble", { hasText: reply }).waitFor({ timeout: 90_000 }), failed.waitFor({ timeout: 90_000 })]);
  if (await failed.isVisible()) throw new Error(`The assistant turn failed: ${await failed.innerText()}`);
  // The page shows "Thinking…" until the whole turn is done and draws the chat once more then.
  await page.waitForFunction(() => !document.querySelector("#message")?.textContent?.includes("Thinking"), undefined, { timeout: 180_000 });
  await page.locator("#timeline .chat-bubble", { hasText: reply }).last().waitFor();
}

/** After a reload the chat draws itself twice; waits for the second, then brings `text` into view. */
async function settled(page: Page, text: string): Promise<void> {
  const bubble = page.locator("#timeline .chat-bubble", { hasText: text }).last();
  for (let calm = 0; calm < 4;) {
    await bubble.waitFor({ timeout: 60_000 });
    await sleep(500);
    calm = (await bubble.isVisible()) ? calm + 1 : 0;
  }
  await bubble.evaluate((element) => element.scrollIntoView({ behavior: "smooth", block: "center" }));
}

const launchPrompt = "Run the release checklist for checkout-api, deploy main to production, run the smoke tests and post the release notes.";

/** The assistant's Scheduled task form, filled in for a launch every Monday at six. Returns the task. */
async function scheduleLaunch(page: Page, touch: boolean): Promise<{ id: string; projectId: string; ownerNodeId: string }> {
  await press(page, page.getByTestId("assistant-new-scheduled-task"), touch);
  const form = page.frameLocator("#assistantAutomationFrame");
  const name = form.getByTestId("cron-name");
  const fresh = form.getByTestId("cron-new");
  await Promise.race([name.waitFor({ timeout: 30_000 }), fresh.waitFor({ timeout: 30_000 })]);
  if (!(await name.isVisible())) await press(page, fresh, touch);
  await sleep(500);
  await write(page, name, "Monday launch", touch ? 40 : 34, touch);
  await write(page, form.getByTestId("cron-prompt"), launchPrompt, touch ? 14 : 11, touch);
  await press(page, form.getByTestId("cron-frequency"), touch);
  await form.getByTestId("cron-frequency").selectOption("weekly");
  await sleep(300);
  await press(page, form.getByTestId("cron-weekday"), touch);
  await form.getByTestId("cron-weekday").selectOption("1");
  await sleep(300);
  await press(page, form.getByTestId("cron-time"), touch);
  await form.getByTestId("cron-time").fill("18:00");
  await sleep(600);
  const created = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/cron" && response.request().method() === "POST");
  await press(page, form.getByTestId("cron-save"), touch);
  const saved = await (await created).json() as { task?: { id: string; projectId: string; ownerNodeId: string }; error?: string };
  if (!saved.task) throw new Error(`The launch was not scheduled: ${JSON.stringify(saved)}`);
  await form.getByTestId("cron-task").filter({ hasText: "Monday launch" }).waitFor();
  return saved.task;
}

async function assistant({ environment, browser, root, finish, openProject }: Kit): Promise<void> {
  const [laptopNode] = environment.nodes;
  const admin = await signIn(environment, laptopNode);
  const project = laptopNode.projects.find((candidate) => candidate.name === "checkout-api")!;
  // The decision model's key for this project. The capture answers its questions itself, so the
  // value is a placeholder; it only has to be there.
  const key = await api<{ account: { id: string } }>(laptopNode, admin, "POST", "/secrets/accounts", { label: "TypeSafe", provider: "custom", projectId: project.id, variables: [{ name: "TYPESAFE_AI_API_KEY", kind: "value", value: "capture-stand-in" }] });
  if (!key.body.account) throw new Error(`Could not add the decision model key: ${JSON.stringify(key.body)}`);
  const attached = await api(laptopNode, admin, "PUT", `/secrets/scopes/project/${encodeURIComponent(project.id)}`, { accountIds: [key.body.account.id] });
  if (attached.status >= 300) throw new Error(`Could not attach the key: ${JSON.stringify(attached.body)}`);

  const { page } = await openStage(browser, environment, laptopNode, desktop);
  await openProject(page, "checkout-api");
  await page.locator("#collapseProjectsButton").click();
  await newConversation(page, "Release assistant");
  // A conversation with a first exchange in it, as one has by the time it becomes an assistant.
  await page.locator("#messageInput").fill("You're the release assistant for checkout-api.");
  await page.locator("#sendButton").click();
  await answer(page, "keep track of the checkout-api work").waitFor({ timeout: 60_000 });
  await sleep(1500);
  const events: Record<string, number> = {};
  const recording = await record(page, root, "assistant");
  await sleep(700);
  // Any conversation can become an assistant.
  await glideClick(page, '[data-testid="chat-personal-assistant-button"]', { ms: 420 });
  await page.getByTestId("personal-assistant-dialog").waitFor();
  events.dialog = now();
  await page.getByTestId("personal-assistant-name").fill("");
  await type(page, '[data-testid="personal-assistant-name"]', "Release assistant", 36);
  await sleep(400);
  await glideClick(page, '[data-testid="personal-assistant-create"]', { ms: 340 });
  await page.locator("#heading").getByText("Release assistant").waitFor();
  events.page = now();
  const assistantId = new URL(page.url()).searchParams.get("id")!;
  await sleep(900);
  await glideClick(page, '[data-testid="assistant-view-settings"]', { ms: 360 });
  await page.locator("#instructions").waitFor();
  await sleep(500);
  await type(page, "#instructions", "Keep me posted on the checkout work, put meetings in my calendar, and run our releases when they are due.", 14);
  await sleep(300);
  await glideClick(page, "#settings button.primary", { ms: 320 });
  events.instructions = now();
  await sleep(1200);
  await glideClick(page, '[data-testid="assistant-view-chat"]', { ms: 360 });
  await page.locator("#chat-message").waitFor();
  await sleep(600);

  // How a feature is going, from the work in the project's conversations.
  events.asked = now();
  await chat(page, "How far along is the payment retry feature?", "on track", false);
  events.answered = now();
  await sleep(3200);
  // A meeting, in his calendar.
  events.book = now();
  await chat(page, "Book 30 minutes with Maya tomorrow at 10 to review it.", "Booked", false);
  events.booked = now();
  await sleep(3000);

  // At lunch, on his phone: the same assistant, a question, and the launch scheduled for six.
  const mobile = await openStage(browser, environment, laptopNode, phone, { scale: 3, mobile: true });
  const phoneRecording = await record(mobile.page, root, "assistantPhone");
  await mobile.page.goto(`${laptopNode.url}/assistant.html?id=${assistantId}`);
  await mobile.page.locator("#chat-message").waitFor();
  await sleep(900);
  const phoneEvents: Record<string, number> = { opened: now() };
  await chat(mobile.page, "Is the retry fix ready for tonight?", "6:00 PM launch", true);
  phoneEvents.answered = now();
  await sleep(2600);
  phoneEvents.schedule = now();
  const task = await scheduleLaunch(mobile.page, true);
  phoneEvents.scheduled = now();
  await sleep(2600);
  await finish("assistantPhone", phoneRecording, phoneEvents);
  await mobile.context.close();

  // Back on the laptop: the phone's exchange is in the same chat, and the launch in its tasks.
  await page.reload();
  await settled(page, "6:00 PM launch");
  events.synced = now();
  await sleep(2400);
  await glideClick(page, '[data-testid="assistant-new-scheduled-task"]', { ms: 380 });
  const form = page.frameLocator("#assistantAutomationFrame");
  await form.getByTestId("cron-task").filter({ hasText: "Monday launch" }).waitFor({ timeout: 30_000 });
  events.tasks = now();
  await sleep(2800);
  await page.keyboard.press("Escape");
  await page.locator("#assistant-automation-dialog").waitFor({ state: "hidden" });
  await sleep(800);

  // Monday, six o'clock: the launch runs through the assistant and reports in its chat.
  const started = await api(laptopNode, admin, "POST", "/cron", { nodeId: task.ownerNodeId, command: { action: "run", id: task.id, projectId: task.projectId } });
  if (started.status !== 200) throw new Error(`The launch did not start: ${JSON.stringify(started.body)}`);
  events.run = now();
  for (let attempt = 0; ; attempt++) {
    const transcript = await api<{ timeline: Array<{ text: string }> }>(laptopNode, admin, "GET", `/personal-assistants/${assistantId}/transcript`);
    if ((transcript.body.timeline ?? []).some((item) => item.text.includes("is live"))) break;
    if (attempt > 180) throw new Error("The launch never reported back");
    await sleep(500);
  }
  await page.reload();
  await settled(page, "is live");
  events.launched = now();
  await sleep(3400);
  await finish("assistant", recording, events);

  // The same report on his phone, for the film's last scene.
  const after = await openStage(browser, environment, laptopNode, phone, { scale: 3, mobile: true });
  const launchRecording = await record(after.page, root, "launchPhone");
  await after.page.goto(`${laptopNode.url}/assistant.html?id=${assistantId}`);
  await settled(after.page, "is live");
  const launchEvents: Record<string, number> = { report: now() };
  await sleep(3600);
  await finish("launchPhone", launchRecording, launchEvents);
  await after.context.close();
}

/* ---------- Phone ---------- */

async function phoneAccess({ environment, browser, root, finish, openProject, openProjectOnPhone }: Kit): Promise<void> {
  const [laptopNode, serverNode] = environment.nodes;
  // The work started at the desk, on the machine that stays on.
  const laptop = await openStage(browser, environment, laptopNode, desktop);
  await openProject(laptop.page, "checkout-api");
  await newConversation(laptop.page, "Payment retry double-charge", serverNode.name);
  await laptop.page.locator("#messageInput").fill("Payment retries double-charge customers when the provider times out. Find the cause and fix it.");
  await laptop.page.locator("#sendButton").click();
  await answer(laptop.page, "fails as expected").waitFor({ timeout: 60_000 });
  await laptop.context.close();

  const mobile = await openStage(browser, environment, serverNode, phone, { scale: 3, mobile: true });
  const events: Record<string, number> = {};
  const recording = await record(mobile.page, root, "pocket");
  await sleep(600);
  // The browser offers to install the app; the page shows its own banner for that.
  await mobile.page.evaluate(() => { const banner = document.querySelector("#installBanner") as HTMLElement | null; if (banner) banner.hidden = false; });
  events.banner = now();
  await sleep(2600);
  await mobile.page.evaluate(() => { const banner = document.querySelector("#installBanner") as HTMLElement | null; if (banner) banner.hidden = true; });
  await openProjectOnPhone(mobile.page, "checkout-api");
  events.project = now();
  await sleep(900);
  await openConversation(mobile.page, '#sessionList .list-row:has-text("Payment retry double-charge")', "Payment retry double-charge", { phone: true });
  events.open = now();
  await sleep(3000);
  await tap(mobile.page, "#messageInput");
  await mobile.page.locator("#messageInput").pressSequentially("Ship the fix and open a PR.", { delay: 40 });
  await sleep(300);
  await tap(mobile.page, "#sendButton");
  events.send = now();
  await mobile.page.locator("#jumpToBottomButton").waitFor({ timeout: 2_500 }).then(() => sleep(350)).then(() => tap(mobile.page, "#jumpToBottomButton")).catch(() => {});
  await answer(mobile.page, "PR #212").waitFor({ timeout: 60_000 });
  events.done = now();
  await sleep(3200);
  await finish("pocket", recording, events);
}

/* ---------- Story and Overview ---------- */

async function story({ environment, browser, root, finish, openProject }: Kit): Promise<void> {
  const [laptopNode] = environment.nodes;
  const voices = await speakStoryLines(audioDir);
  const { page } = await openStage(browser, environment, laptopNode, desktop);

  // A writer model would make the story and the script; here they are handed to the page.
  const thread = { id: "story-212", harnessId: "claude", provider: "anthropic", modelId: "claude-opus-5", thinkingLevel: "high", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString() };
  const saved = { story: storyWritten, facts: storyFacts, patches: storyPatches, fingerprint: "promo", sources: { scope: "conversation", pendingPaths: [], includeCommits: true }, generatedAt: thread.createdAt };
  const LOCATIONS = ["podcast", "classroom", "lecture", "coffeehouse", "street", "train", "server", "matrix", "rooftop"];
  const settings = { instructions: "", backdrops: true, locations: LOCATIONS, moods: true, codeSlides: true, codeWriteup: true, maxCodeLines: 12, ask: true, narrate: true, voiceProvider: "kokoro", hostVoice: "af_heart", cohostVoice: "am_michael", speed: 1, voiceChosen: true };
  await page.route("**/api/story-settings", (route) => route.fulfill({ json: { settings, defaultInstructions: "", locations: LOCATIONS.map((id) => ({ id, label: id })), voices: [{ id: "af_heart", label: "Heart" }, { id: "am_michael", label: "Michael" }], voice: { allowed: true, installed: true, installing: false, installError: null, reason: null } } }));
  let script: unknown = null;
  await page.route("**/api/projects/*/git/**", async (route: Route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname.endsWith("/story-latest")) return route.fulfill({ json: { latest: { thread, saved, freshness: { fresh: true, newTurns: 0, changedPaths: [] } }, commits: [] } });
    if (url.pathname.endsWith("/overview")) {
      await sleep(2600);
      script = podcastScript;
      const lines = [{ type: "progress", stage: "Writing the movie" }, { type: "done", thread: { ...thread, id: "overview-212" }, script }];
      return route.fulfill({ contentType: "application/x-ndjson", body: lines.map((line) => JSON.stringify(line)).join("\n") });
    }
    if (url.pathname.endsWith("/story-podcast") && method === "GET") return route.fulfill({ json: { script } });
    if (url.pathname.endsWith("/story-podcast")) {
      const body = route.request().postDataJSON() as { question?: string };
      await sleep(2400);
      script = body.question ? podcastWithAnswer : podcastScript;
      const lines = [{ type: "progress", stage: "Writing with the reviewer" }, { type: "done", script }];
      return route.fulfill({ contentType: "application/x-ndjson", body: lines.map((line) => JSON.stringify(line)).join("\n") });
    }
    if (url.pathname.endsWith("/story-voice") && method === "GET") return route.fulfill({ json: { provider: "kokoro", available: true, reason: null, local: { allowed: true, installed: true, installing: false, installError: null, reason: null } } });
    if (url.pathname.endsWith("/story-voice")) {
      const { text } = route.request().postDataJSON() as { text: string };
      const bytes = voices.get(text.trim());
      return bytes ? route.fulfill({ contentType: "audio/mpeg", body: bytes }) : route.fulfill({ status: 502, json: { error: "No line" } });
    }
    return route.continue();
  });

  await openProject(page, "checkout-api");
  await page.locator("#collapseProjectsButton").click();
  const row = '#sessionList .list-row:has-text("Payment retry double-charge")';
  await openConversation(page, row, "Payment retry double-charge");
  if (await page.getByTestId("chat-activity-toggle").getAttribute("aria-expanded") !== "true") await page.getByTestId("chat-activity-toggle").click();
  await sleep(1200);
  const events: Record<string, number> = {};
  const recording = await record(page, root, "story");
  await sleep(700);
  await glideClick(page, '[data-testid="activity-story-button"]', { ms: 420 });
  await page.getByTestId("git-story-title").waitFor({ timeout: 30_000 });
  events.story = now();
  await sleep(3600);
  for (const section of ["examples", "implementation"]) {
    const tab = `[data-testid="git-story-section-${section}"]`;
    if (await page.locator(tab).count()) { await glideClick(page, tab, { ms: 380 }); events[section] = now(); await sleep(2800); }
  }
  await page.keyboard.press("Escape");
  await sleep(700);
  await glideClick(page, '[data-testid="activity-overview-button"]', { ms: 420 });
  events.overview = now();
  await page.getByTestId("git-story-podcast").waitFor({ timeout: 30_000 });
  events.podcast = now();
  await sleep(1500);
  if (/Play/.test(await page.locator(".gsp-play").first().textContent() ?? "")) await glideClick(page, ".gsp-play", { ms: 380 });
  // When each line is on screen, read from the caption, so the film can lay the same voices under it.
  const seen = new Map<string, number>();
  let polling = true;
  const poller = (async () => {
    while (polling) {
      const caption = ((await page.locator(".gsp-caption").first().textContent().catch(() => "")) ?? "").trim();
      for (const line of spokenLines()) if (caption.includes(line.text) && !seen.has(line.text)) seen.set(line.text, now());
      await sleep(80);
    }
  })();
  const shown = (text: string) => seen.has(text);
  // The first three chapters play through.
  const firstLines = podcastScript.chapters.flatMap((chapter) => chapter.lines);
  for (let waited = 0; waited < 240 && !shown(firstLines[firstLines.length - 1].text); waited++) await sleep(250);
  await sleep(4200);
  events.played = now();
  await type(page, '[data-testid="git-story-podcast-question"]', followUpQuestion, 30);
  await glideClick(page, '[data-testid="git-story-podcast-ask"]', { ms: 340 });
  events.asked = now();
  const lines = spokenLines();
  for (let waited = 0; waited < 360 && !shown(lines[lines.length - 1].text); waited++) await sleep(250);
  await sleep(4500);
  events.answered = now();
  polling = false;
  await poller;
  lines.forEach((line, index) => { const at = seen.get(line.text); if (at) events[`line${index + 1}`] = at; });
  console.log(`lines played: ${lines.filter((line) => seen.has(line.text)).length} of ${lines.length}`);
  await finish("story", recording, events);
}

export const featureTakes: Record<string, (kit: Kit) => Promise<void>> = { pools, budgets, guardian, dashboards, assistant, phone: phoneAccess, story };
