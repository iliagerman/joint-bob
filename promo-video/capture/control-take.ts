// The take behind the control center film, and the Monday film's lunch and six o'clock scenes.
//
//   control   the board of every agent in every project, a Guardian question answered from its card,
//             Bob starting a task in the right project and answering what is left before the release;
//             then on a phone, the same Bob answering and scheduling the Monday launch; then the
//             launch, run at six, waiting for review on the phone
//
// The board is filled before recording, on a page that is not filmed: six conversations in five
// projects, three of them long jobs that keep running while the board is filmed.
import type { AddressInfo } from "node:net";
import type { Page } from "playwright-core";
import { api, signIn } from "./env.js";
import { glideClick, openConversation, openStage, record, tap } from "./browser.js";
import { answer, desktop, newConversation, now, phone, sleep, type Kit } from "./takes.js";
import { startDecisionModel } from "./feature-takes.js";

interface BoardCard { title: string; projectName: string; column: string; summary: string | null; pendingReviews: unknown[] }

/** Sends a message in the open conversation without filming it, and waits for the reply that contains `reply`. */
async function send(page: Page, text: string, reply: string): Promise<void> {
  await page.locator("#messageInput:not([disabled])").fill(text);
  await page.locator("#sendButton").click();
  await answer(page, reply).waitFor({ timeout: 90_000 });
}

/** Types into Bob's message box and sends, by hand on a desktop or by touch on a phone. */
async function tellBob(page: Page, text: string, touch: boolean): Promise<void> {
  const input = '[data-testid="control-chat-input"]';
  if (touch) await tap(page, input);
  else await glideClick(page, input, { ms: 380 });
  await page.locator(input).pressSequentially(text, { delay: touch ? 32 : 26 });
  await sleep(300);
  if (touch) await tap(page, '[data-testid="control-chat-send"]');
  else await glideClick(page, '[data-testid="control-chat-send"]', { ms: 300 });
}

const bobSaid = (page: Page, text: string) => page.locator('[data-testid="control-chat-entry"]', { hasText: text }).last();

async function control({ environment, browser, root, finish, openProject }: Kit): Promise<void> {
  const [laptopNode] = environment.nodes;
  const admin = await signIn(environment, laptopNode);
  const guard = await startDecisionModel();
  try {
    // Bob's decision model reads its key from the first project that has one. The capture answers
    // its questions itself (decisions.ts), so the value only has to be there.
    const checkout = laptopNode.projects.find((candidate) => candidate.name === "checkout-api")!;
    const key = await api<{ account: { id: string } }>(laptopNode, admin, "POST", "/secrets/accounts", { label: "TypeSafe", provider: "custom", projectId: checkout.id, variables: [{ name: "TYPESAFE_AI_API_KEY", kind: "value", value: "capture-stand-in" }] });
    if (!key.body.account) throw new Error(`Could not add the decision model key: ${JSON.stringify(key.body)}`);
    const attached = await api(laptopNode, admin, "PUT", `/secrets/scopes/project/${encodeURIComponent(checkout.id)}`, { accountIds: [key.body.account.id] });
    if (attached.status >= 300) throw new Error(`Could not attach the key: ${JSON.stringify(attached.body)}`);
    // Only the scripted Claude runs here, so Bob's own agent is Claude; Bob leaves auto respond off.
    const bobSettings = await api(laptopNode, admin, "PUT", "/control-center/bob/settings", { harnessId: "claude", autoRespond: "never" });
    if (bobSettings.status !== 200) throw new Error(`Bob's settings refused: ${JSON.stringify(bobSettings.body)}`);
    // Guardian on, asking its stand-in model (feature-takes.ts), so the snapshot delete waits for an OK.
    const current = await api<{ settings: Record<string, unknown> }>(laptopNode, admin, "GET", "/guardian");
    const configured = await api(laptopNode, admin, "PUT", "/guardian", { settings: { ...current.body.settings, enabled: true, model: "laya-remote", layaUrl: `http://127.0.0.1:${(guard.address() as AddressInfo).port}` } });
    if (configured.status !== 200) throw new Error(`Guardian settings refused: ${JSON.stringify(configured.body)}`);

    // ---------- The board, filled off camera ----------
    const prep = (await openStage(browser, environment, laptopNode, desktop)).page;
    // Nothing here is filmed, so a busy machine gets more time.
    prep.context().setDefaultTimeout(60_000);
    const start = async (project: string, title: string, first: string, reply: string, next?: string): Promise<void> => {
      await openProject(prep, project);
      // Just after the nodes start, the wizard sometimes never offers the message box; once is retried.
      await newConversation(prep, title).catch(async () => {
        await prep.screenshot({ path: "/tmp/control-wizard-failed.png" });
        await prep.reload();
        await openProject(prep, project);
        await newConversation(prep, title);
      });
      await send(prep, first, reply);
      // The summary is written from the first answer; the long job is the second message.
      await sleep(3500);
      if (next) {
        await prep.locator("#messageInput:not([disabled])").fill(next);
        await prep.locator("#sendButton").click();
        await sleep(2500);
      }
    };
    await start("support-line", "This week's escalations", "Summarize this week's escalations and draft replies.", "9 escalations");
    await start("checkout-api", "Payment retry double-charge", "Fix the payment retry double-charge and open a PR.", "PR #212");

    // Guardian files a pause under the conversation once it has its record, which it gets with its
    // first turn; the page is reopened on it before the delete is asked (as in the guardian take).
    await openProject(prep, "infra");
    await newConversation(prep, "Staging ready for tonight");
    await send(prep, "Get the staging cluster ready for tonight.", "38 old database snapshots");
    await sleep(2500);
    await prep.reload();
    await openProject(prep, "infra");
    await openConversation(prep, '#sessionList .list-row:has-text("Staging ready for tonight")', "Staging ready for tonight");
    await answer(prep, "38 old database snapshots").waitFor({ timeout: 30_000 });
    await sleep(2000);
    await prep.locator("#messageInput:not([disabled])").fill("Clear the old staging snapshots to free space.");
    await prep.locator("#sendButton").click();
    await prep.getByTestId("guardian-review").waitFor({ timeout: 60_000 });

    await start("mobile-app", "React Native 0.80 upgrade", "What breaks if we upgrade React Native to 0.80?", "Three breaking changes", "Do the React Native upgrade and get the iOS build green.");
    await start("billing-worker", "Duplicate annual invoices", "Why do annual-plan invoices go out twice? Look into it.", "Found it", "Fix the duplicate invoices and add a test.");
    await start("web-storefront", "Product grid on the design system", "Plan moving the product grid to the new design system.", "22 components", "Go ahead and move the product grid.");

    // Wait until the board has what the film shows: the question, three jobs running, two to review, all with summaries.
    for (let attempt = 0; ; attempt++) {
      const board = await api<{ cards: BoardCard[] }>(laptopNode, admin, "GET", "/control-center/board");
      const cards = board.body.cards ?? [];
      const ready = cards.some((card) => card.pendingReviews?.length)
        && cards.filter((card) => card.column === "running").length >= 3
        && cards.filter((card) => card.column === "review").length >= 2
        && cards.every((card) => card.summary);
      if (ready) break;
      if (attempt > 120) throw new Error(`The board never filled: ${JSON.stringify(cards.map(({ title, column, summary }) => ({ title, column, summary: Boolean(summary) })))}`);
      await sleep(1000);
    }
    await prep.context().close();

    // ---------- On the laptop: the control center ----------
    const { page } = await openStage(browser, environment, laptopNode, desktop);
    await openProject(page, "checkout-api");
    // Opened off camera, with the project and conversation lists folded away, so the board and Bob's
    // chat get the whole window, as on a wider screen.
    await page.locator("#openControlCenterButton").click();
    await page.locator('[data-testid="control-center-card"]').first().waitFor();
    await page.locator("#collapseProjectsButton").click();
    await page.locator("#collapseChatsButton").click();
    await sleep(2500);
    const events: Record<string, number> = {};
    const recording = await record(page, root, "control");
    await sleep(900);
    events.board = now();
    await page.mouse.move(640, 420, { steps: 12 });
    await sleep(5200);

    // A Guardian question, answered from its card.
    await page.locator('[data-testid="control-center-need"]').first().waitFor();
    events.need = now();
    await sleep(2600);
    await glideClick(page, '[data-testid="control-review-allow"]', { ms: 420 });
    events.allowed = now();
    await page.locator('[data-testid="control-center-need"]').waitFor({ state: "detached", timeout: 30_000 });
    events.cleared = now();
    await sleep(2600);

    // Bob starts a task in the project it is about.
    events.task = now();
    await tellBob(page, "Add a rate limit to the coupon endpoint in checkout-api.", false);
    await bobSaid(page, "Started in checkout-api").waitFor({ timeout: 90_000 });
    events.started = now();
    await page.locator('[data-testid="control-center-card"]', { hasText: /coupon/i }).first().waitFor({ timeout: 30_000 });
    events.card = now();
    await sleep(3600);

    // And answers from what is running.
    events.question = now();
    await tellBob(page, "What's left before tonight's release?", false);
    await bobSaid(page, "Three things").waitFor({ timeout: 90_000 });
    events.answered = now();
    await sleep(5200);
    await finish("control", recording, events);
    await page.context().close();

    // ---------- On the phone, at lunch: the same Bob ----------
    const mobile = (await openStage(browser, environment, laptopNode, phone, { scale: 3, mobile: true })).page;
    await mobile.goto(`${laptopNode.url}/?action=control-center`);
    await mobile.locator('[data-testid="control-chat-input"]').waitFor();
    await sleep(1500);
    const phoneEvents: Record<string, number> = {};
    const phoneRecording = await record(mobile, root, "controlPhone");
    await sleep(900);
    phoneEvents.opened = now();
    await sleep(1800);
    phoneEvents.ask = now();
    await tellBob(mobile, "Is the payment retry fix ready for tonight?", true);
    await bobSaid(mobile, "48 of 48 tests pass").waitFor({ timeout: 90_000 });
    phoneEvents.answered = now();
    await sleep(2800);
    phoneEvents.schedule = now();
    await tellBob(mobile, "Schedule our release in checkout-api for every Monday at 6 PM.", true);
    const create = mobile.locator('[data-testid="control-chat-entry"] .control-action', { hasText: "Create it" }).last();
    await create.waitFor({ timeout: 90_000 });
    phoneEvents.proposal = now();
    await sleep(2400);
    await tap(mobile, '[data-testid="control-chat-entry"]:last-child .control-action.primary');
    await mobile.waitForFunction(() => document.querySelectorAll('[data-testid="control-chat-entry"]').length > 0 && !/Create it/.test(document.querySelector('[data-testid="control-chat-entry"]:last-child')?.textContent ?? ""), undefined, { timeout: 30_000 });
    phoneEvents.scheduled = now();
    await sleep(3200);
    await finish("controlPhone", phoneRecording, phoneEvents);
    await mobile.context().close();

    // ---------- Six o'clock: the launch runs, and waits on the phone ----------
    const automations = await api<{ rows: Array<{ kind: string; id: string; name: string; projectId: string; nodeId?: string }> }>(laptopNode, admin, "GET", "/control-center/automations");
    const task = (automations.body.rows ?? []).find((row) => row.kind === "schedule" && row.name === "Monday launch");
    if (!task) throw new Error(`The launch was not scheduled: ${JSON.stringify(automations.body)}`);
    // Bob gives a task the machine's usual agent, which is Pi when Pi can run; only the scripted
    // Claude runs here, so the task is switched to it, off camera, with the editor's own update.
    const nodeId = task.nodeId ?? laptopNode.nodeId;
    const listed = await api<{ tasks: Array<Record<string, unknown>> }>(laptopNode, admin, "POST", "/cron", { nodeId, command: { action: "list", projectId: task.projectId } });
    const stored = (listed.body.tasks ?? []).find((entry) => entry.id === task.id);
    if (!stored) throw new Error(`The launch is not in the project's tasks: ${JSON.stringify(listed.body).slice(0, 400)}`);
    const keys = ["creatorAccountId", "assistantId", "providerProfileId", "tags", "projectId", "name", "prompt", "ownerNodeId", "engine", "model", "reasoning", "autoRespond", "sessionId", "enabled", "pauseOnFailure", "markForReview", "hideFromHistory", "schedule"];
    const input = { ...Object.fromEntries(keys.filter((name) => name in stored).map((name) => [name, stored[name]])), engine: "claude", model: null, markForReview: true };
    const updated = await api(laptopNode, admin, "POST", "/cron", { nodeId, command: { action: "update", id: task.id, input } });
    if (updated.status !== 200) throw new Error(`The launch could not be switched to Claude: ${JSON.stringify(updated.body)}`);
    const run = await api(laptopNode, admin, "POST", "/cron", { nodeId, command: { action: "run", id: task.id, projectId: task.projectId } });
    if (run.status !== 200) throw new Error(`The launch did not start: ${JSON.stringify(run.body)}`);
    for (let attempt = 0; ; attempt++) {
      const board = await api<{ cards: BoardCard[] }>(laptopNode, admin, "GET", "/control-center/board");
      if ((board.body.cards ?? []).some((card) => /launch/i.test(card.title) && card.column === "review")) break;
      if (attempt > 120) throw new Error(`The launch never finished: ${JSON.stringify((board.body.cards ?? []).map(({ title, column }) => ({ title, column })))}`);
      await sleep(1000);
    }
    const after = (await openStage(browser, environment, laptopNode, phone, { scale: 3, mobile: true })).page;
    await after.goto(`${laptopNode.url}/?action=control-center`);
    await after.locator('[data-testid="control-phone-strip"]').waitFor();
    await sleep(1500);
    const launchEvents: Record<string, number> = {};
    const launchRecording = await record(after, root, "launchBob");
    await sleep(1200);
    launchEvents.strip = now();
    await tap(after, '[data-testid="control-phone-strip"] button:has-text("to review")');
    await after.locator('[data-testid="control-phone-row"]', { hasText: /launch/i }).first().waitFor();
    launchEvents.sheet = now();
    await sleep(2200);
    await tap(after, '[data-testid="control-phone-row"]:has-text("launch") [data-testid="control-phone-review"]');
    await after.getByText(/v2\.4 is live/).first().waitFor({ timeout: 30_000 }).catch(async (error) => {
      await after.screenshot({ path: "/tmp/control-launch-failed.png" });
      throw error;
    });
    launchEvents.report = now();
    await sleep(3600);
    await finish("launchBob", launchRecording, launchEvents);
    await after.context().close();
  } finally {
    guard.close();
  }
}

export const controlTakes: Record<string, (kit: Kit) => Promise<void>> = { control };
