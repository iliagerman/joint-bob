import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";

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

test("the bell counts new triggers that can wait, lists them a page at a time, and each can be opened, triaged by Bob or dismissed", { timeout: 180_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment);
  const projects = await page.evaluate(async () => (await (await fetch("/api/projects")).json()).projects as Array<{ id: string; name: string }>);
  const project = projects[0];

  await page.evaluate(`(() => {
    const originalFetch = window.fetch;
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const project = ${JSON.stringify(project)};
    const make = (index, state, urgency, rating, extra = {}) => ({
      id: 't' + index, webhookId: 'w1', webhookName: 'GitHub', projectId: project.id, projectName: project.name, title: 'Issue #' + (480 + index) + ' opened: Problem number ' + index,
      summary: 'acme/joint-bob · by matan', receivedAt: new Date(Date.now() - index * 600000).toISOString(), state, urgency, snoozedUntil: null, rating, ...extra });
    const sure = { by: 'decision-model', confidence: 0.93, label: 'not urgent (93%)', reason: '' };
    const unsure = { by: 'agent', confidence: 0.62, label: 'decision model unsure, Bob checked', reason: 'A docs typo.' };
    const paused = { by: 'none', confidence: null, label: '', reason: '' };
    window.__triggers = [
      make(1, 'new', 'not-urgent', sure), make(2, 'new', 'not-urgent', unsure), make(3, 'new', 'unrated', paused), make(4, 'new', 'not-urgent', sure),
      make(5, 'new', 'not-urgent', sure), make(6, 'seen', 'not-urgent', sure), make(7, 'seen', 'not-urgent', sure), make(8, 'seen', 'not-urgent', sure), make(9, 'seen', 'not-urgent', sure),
    ];
    window.__make = make; window.__sure = sure;
    window.__requests = [];
    window.__bobMessages = [];
    window.__timeline = [{ id: 'urgent1', role: 'system', text: 'Alarm ALARM: api-5xx\\n5xx at 14%', via: 'Webhook · GitHub · decision model 95%', projectId: project.id, projectName: project.name, importance: 'urgent', createdAt: new Date().toISOString(),
      actions: [{ id: 'trigger.investigate', label: 'Investigate (read-only)', style: 'primary', data: { triggerId: 'u1' } }, { id: 'trigger.open', label: 'Open', data: { triggerId: 'u1', projectId: project.id, projectName: project.name } }, { id: 'trigger.snooze', label: 'Snooze 1h', data: { triggerId: 'u1' } }] }];
    const live = () => window.__triggers.filter((trigger) => trigger.state !== 'dismissed');
    window.fetch = async (...args) => {
      const url = new URL(String(args[0]), location.href);
      const method = (args[1]?.method || 'GET').toUpperCase();
      const body = args[1]?.body ? JSON.parse(args[1].body) : undefined;
      if (url.pathname === '/api/control-center/triggers' && method === 'GET') {
        const page = Number(url.searchParams.get('page') || 1), size = Number(url.searchParams.get('size') || 10);
        window.__requests.push({ list: { page, size } });
        return json({ triggers: live().slice((page - 1) * size, page * size), total: live().length, newCount: live().filter((trigger) => trigger.state === 'new').length });
      }
      if (url.pathname === '/api/control-center/triggers/seen' && method === 'POST') {
        window.__requests.push({ seen: body.ids });
        let marked = 0;
        for (const trigger of window.__triggers) if (body.ids.includes(trigger.id) && trigger.state === 'new') { trigger.state = 'seen'; marked += 1; }
        return json({ marked });
      }
      if (url.pathname === '/api/control-center/triggers/dismiss' && method === 'POST') {
        window.__requests.push({ dismiss: body });
        let dismissed = 0;
        for (const trigger of window.__triggers) if (trigger.state !== 'dismissed' && (body.all || body.ids.includes(trigger.id))) { trigger.state = 'dismissed'; dismissed += 1; }
        return json({ dismissed });
      }
      const triage = /^\\/api\\/control-center\\/triggers\\/([^/]+)\\/triage$/.exec(url.pathname);
      if (triage) {
        const trigger = window.__triggers.find((candidate) => candidate.id === triage[1]);
        window.__requests.push({ triage: trigger.id });
        return json({ message: 'Triage this incoming webhook call for me: ' + trigger.title, projectId: trigger.projectId });
      }
      if (url.pathname === '/api/control-center/bob/action') { window.__requests.push({ action: body }); return json({ messages: [] }); }
      if (url.pathname === '/api/control-center/bob/message') {
        window.__requests.push({ message: body });
        const user = { id: 'm1', role: 'user', text: body.message, via: null, projectId: body.projectId ?? null, projectName: null, importance: 'fyi', actions: [], createdAt: new Date().toISOString() };
        const reply = { id: 'm2', role: 'bob', text: 'It is a routine report; nothing is broken.', via: 'Decision model 95% · question', projectId: body.projectId ?? null, projectName: null, importance: 'fyi', actions: [], createdAt: new Date().toISOString() };
        window.__timeline.push(user, reply);
        return json({ action: 'answer', user, reply, projectId: body.projectId ?? null });
      }
      if (url.pathname === '/api/control-center/bob/messages') return json({ messages: window.__timeline, waiting: 1 });
      if (url.pathname === '/api/control-center/board') return json({ cards: [], projects: ${JSON.stringify(projects)}.map((item) => ({ id: item.id, name: item.name })) });
      return originalFetch(...args);
    };
  })()`);

  await page.getByTestId("projects-open-control-center-button").click();
  await page.getByTestId("control-chat").waitFor();

  // The bell sits next to the monitoring switch in Bob's header, and counts only what is new and can wait.
  const bell = page.getByTestId("control-triggers-bell");
  await bell.waitFor();
  assert.equal(await bell.evaluate((node) => node.nextElementSibling?.id), "controlChatMonitor");
  await page.waitForFunction(() => document.querySelector('[data-testid="control-triggers-count"]')?.textContent === "5");
  assert.equal(await page.getByTestId("control-triggers-panel").isHidden(), true);

  // Opening it lists the first page, sized to the panel so nothing scrolls; the rest is on the next pages.
  await bell.click();
  await page.getByTestId("control-triggers-panel").waitFor({ state: "visible" });
  await page.getByTestId("control-trigger").first().waitFor();
  const rows = page.getByTestId("control-trigger");
  const firstPage = await rows.count();
  assert.ok(firstPage >= 2 && firstPage < 9, `a page holds what fits, got ${firstPage}`);
  assert.equal(await page.getByTestId("control-triggers-list").evaluate((list) => list.scrollHeight <= list.clientHeight + 1), true, "the list fits its box");
  assert.match(await rows.first().innerText(), /Issue #481 opened: Problem number 1 · .*\n.*acme\/joint-bob · by matan\n.*webhook GitHub · 10 min ago · not urgent \(93%\)/);
  assert.deepEqual(await rows.first().getByRole("button").allTextContents(), ["Open", "Ask Bob to triage", "Dismiss"]);
  assert.match(await rows.nth(1).getByTestId("control-trigger-meta").innerText(), /decision model unsure, Bob checked/);
  assert.equal(await rows.first().getAttribute("data-state"), "new");
  assert.match(await page.getByTestId("control-triggers-page-label").innerText(), new RegExp(`^1–${firstPage} of 9$`));
  assert.equal(await page.getByTestId("control-triggers-page-previous").isDisabled(), true);
  await page.getByTestId("control-triggers-page-next").click();
  await page.waitForFunction((count) => document.querySelector('[data-testid="control-trigger"]')?.getAttribute("data-id") === `t${count + 1}`, firstPage);
  // A trigger that arrived while Bob was paused was not rated; the list says so.
  while (await page.locator('[data-testid="control-trigger"][data-urgency="unrated"]').count() === 0) await page.getByTestId("control-triggers-page-next").click();
  assert.match(await page.locator('[data-testid="control-trigger"][data-urgency="unrated"] [data-testid="control-trigger-meta"]').innerText(), /not rated yet: Bob was paused/);
  while (await page.getByTestId("control-triggers-page-previous").isEnabled()) await page.getByTestId("control-triggers-page-previous").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="control-trigger"]')?.getAttribute("data-id") === "t1");

  // Closing the panel marks what it showed as seen, and the count follows.
  await bell.click();
  await page.getByTestId("control-triggers-panel").waitFor({ state: "hidden" });
  const seen = (await page.evaluate("window.__requests") as Array<{ seen?: string[] }>).find((entry) => entry.seen)!.seen!;
  assert.ok(seen.includes("t1") && seen.every((id) => ["t1", "t2", "t3", "t4", "t5"].includes(id)), `only what was new and shown: ${seen}`);
  await page.waitForFunction((count) => document.querySelector('[data-testid="control-triggers-count"]')?.textContent === String(5 - count) || (count === 5 && document.querySelector<HTMLElement>('[data-testid="control-triggers-count"]')!.hidden), seen.length);

  // Ask Bob to triage: the question goes through Bob's chat like anything typed there, with the trigger's project, and a half-typed message stays.
  await page.getByTestId("control-chat-input").fill("half typed message");
  await bell.click();
  await page.getByTestId("control-trigger").first().waitFor();
  await page.getByTestId("control-trigger-triage").first().click();
  await page.getByTestId("control-chat-messages").getByText("It is a routine report; nothing is broken.").waitFor();
  const sent = (await page.evaluate("window.__requests") as Array<{ message?: { message: string; projectId?: string } }>).find((entry) => entry.message)!.message!;
  assert.equal(sent.message, "Triage this incoming webhook call for me: Issue #481 opened: Problem number 1");
  assert.equal(sent.projectId, project.id);
  assert.equal(await page.getByTestId("control-chat-input").inputValue(), "half typed message", "what the person was typing is kept");
  assert.equal(await page.getByTestId("control-chat-project").inputValue(), "", "the project choice is put back");
  assert.equal(await page.getByTestId("control-triggers-panel").isHidden(), true, "the panel gets out of the way of the answer");
  assert.match(await page.getByTestId("control-chat-messages").innerText(), /Triage this incoming webhook call for me: Issue #481/);
  await page.getByTestId("control-chat-input").fill("");

  // Dismiss one, then all.
  await bell.click();
  await page.getByTestId("control-trigger").first().waitFor();
  await page.getByTestId("control-trigger-dismiss").first().click();
  await page.waitForFunction(() => document.querySelector('[data-testid="control-trigger"]')?.getAttribute("data-id") === "t2");
  assert.equal((await page.evaluate("window.__requests") as Array<{ dismiss?: unknown }>).filter((entry) => entry.dismiss).length, 1);
  assert.match(await page.getByTestId("control-triggers-page-label").innerText(), /of 8$/);
  await page.getByTestId("control-triggers-dismiss-all").click();
  await page.getByText("Nothing is waiting.").waitFor();
  assert.equal(await page.getByTestId("control-triggers-dismiss-all").isDisabled(), true);
  assert.equal(await page.getByTestId("control-triggers-count").isHidden(), true);
  assert.deepEqual((await page.evaluate("window.__requests") as Array<{ dismiss?: unknown }>).filter((entry) => entry.dismiss).at(-1), { dismiss: { all: true } });

  // One that arrives while the panel is open appears in it at once; with the panel closed it counts on the bell.
  await page.evaluate(`(() => { window.__triggers.push(window.__make(0, 'new', 'not-urgent', window.__sure, { title: 'Stripe invoice.payment_failed (test mode)' })); window.dispatchEvent(new CustomEvent('control-center-changed')); })()`);
  await page.getByTestId("control-trigger-title").getByText("Stripe invoice.payment_failed (test mode)").waitFor();
  assert.equal(await page.getByTestId("control-triggers-count").textContent(), "1");
  await bell.click();
  await page.getByTestId("control-triggers-panel").waitFor({ state: "hidden" });
  await page.getByTestId("control-triggers-count").waitFor({ state: "hidden" });
  await page.evaluate(`(() => { window.__triggers.push(window.__make(10, 'new', 'not-urgent', window.__sure)); window.dispatchEvent(new CustomEvent('control-center-changed')); })()`);
  await page.waitForFunction(() => document.querySelector('[data-testid="control-triggers-count"]')?.textContent === "1");

  // Open goes to the webhook's own screen in the project; Esc closes the panel without leaving the control center.
  await bell.click();
  await page.getByTestId("control-trigger").first().waitFor();
  await page.keyboard.press("Escape");
  await page.getByTestId("control-triggers-panel").waitFor({ state: "hidden" });
  assert.equal(await page.locator("body.view-control").count(), 1, "Esc closed the panel, not the control center");
  await bell.click();
  await page.getByTestId("control-trigger-open").first().click();
  await page.getByTestId("project-webhooks-dialog").waitFor();
  assert.match(await page.locator("#projectWebhooksHeading").innerText(), new RegExp(`^${project.name} webhooks$`));
  await page.getByTestId("project-webhooks-close").click();
  await page.getByTestId("project-webhooks-dialog").waitFor({ state: "detached" });
  assert.equal(await page.getByTestId("control-triggers-panel").isHidden(), true, "Open closes the panel");

  // An urgent one is a message in Bob's chat; its Open button is answered by the server and opens the same screen.
  const urgent = page.getByTestId("control-chat-entry").filter({ hasText: "Alarm ALARM: api-5xx" });
  assert.deepEqual(await urgent.getByRole("button").allTextContents(), ["Investigate (read-only)", "Open", "Snooze 1h"]);
  // The message's head names where it came from; how it was decided is the line under it.
  assert.match(await urgent.innerText(), /^Webhook[\s\S]*Urgent[\s\S]*GitHub · decision model 95%/);
  await urgent.getByRole("button", { name: "Open" }).click();
  await page.getByTestId("project-webhooks-dialog").waitFor();
  assert.deepEqual((await page.evaluate("window.__requests") as Array<{ action?: unknown }>).find((entry) => entry.action)!.action, { messageId: "urgent1", actionId: "trigger.open" });
  await page.getByTestId("project-webhooks-close").click();

  // A click outside the panel closes it.
  await bell.click();
  await page.getByTestId("control-triggers-panel").waitFor({ state: "visible" });
  await page.getByTestId("control-chat-messages").click({ position: { x: 5, y: 5 } });
  await page.getByTestId("control-triggers-panel").waitFor({ state: "hidden" });
});
