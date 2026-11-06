import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";

const REVIEW = { id: "r1", title: "Claude wants to run a command", subject: "aws ecs update-service --force-new-deployment --cluster julian-prod", detail: "Production or destructive steps · 98%", expiresAt: "2026-11-05T10:10:00Z" };

const card = (overrides: Record<string, unknown>) => ({
  projectId: "p1", projectName: "Contigos · Julian", conversationId: "c1", sessionId: "c1", path: "/c1", title: "Prod 5xx", column: "running", agentId: "claude", agentLabel: "Claude", agentModel: null,
  executionNodeId: null, updatedAt: "2026-11-05T10:00:00Z", turnRunning: true, backgroundRunning: false, summary: null, autoRespondActive: false, startedBy: "you", pendingReviews: [], autoRespondStop: null, controlledBy: null, ...overrides,
});

const TIMELINE = [
  { id: "g1", role: "system", text: "Julian wants to run: aws ecs update-service --force-new-deployment", via: null, projectId: "p1", projectName: "Contigos · Julian", importance: "needs-ok", actions: [{ id: "guardian.allow", label: "Allow once", style: "warn", data: {} }, { id: "guardian.block", label: "Block", data: {} }], createdAt: "2026-11-05T09:00:00Z" },
  { id: "q1", role: "bob", text: "Which database should the billing job use?", via: null, projectId: null, projectName: null, importance: "needs-you", actions: [], createdAt: "2026-11-05T09:05:00Z" },
];

async function signIn(page: Page, node: { url: string }, environment: { username: string; password: string }, url = node.url) {
  await page.goto(url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.locator(".project-card").first().waitFor();
  await page.waitForFunction(() => !document.body.classList.contains("booting"));
  // Boot resets the view as its last step; open the control center only after that.
  await page.waitForFunction(async () => (await import("/app/state.js")).state.preferencesLoaded);
  await page.waitForTimeout(500);
}

/** Everything inside Bob's chat must sit inside the screen, and the page itself must not scroll sideways. */
async function sideways(page: Page) {
  return page.evaluate(() => {
    const outside = [...document.querySelectorAll("#controlChat *")].filter((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && (box.right > innerWidth + 1 || box.left < -1);
    }).map((element) => `${element.tagName.toLowerCase()}.${element.className}`);
    return { page: document.documentElement.scrollWidth - innerWidth, chat: document.querySelector("#controlChat")!.scrollWidth - document.querySelector("#controlChat")!.clientWidth, outside };
  });
}

test("on a phone the control center is Bob's chat, with chips, an agents sheet and approvals", { timeout: 240_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 360, height: 800 });
  await signIn(page, node, environment);

  // A real conversation from the seeded projects, shown as a running card the sheet can open.
  const real = await page.evaluate(`(async () => {
    const { projects } = await (await fetch('/api/projects')).json();
    for (const project of projects) {
      const { sessions } = await (await fetch('/api/projects/' + project.id + '/sessions')).json();
      if (sessions.length) { const session = sessions[0]; return { projectId: project.id, projectName: project.name, conversationId: session.conversationId ?? session.id, sessionId: session.id, path: session.path, title: session.title }; }
    }
    throw new Error('no seeded conversation');
  })()`) as { projectId: string; projectName: string; conversationId: string; sessionId: string; path: string; title: string };

  await page.evaluate(`(() => {
    const originalFetch = window.fetch;
    const card = ${card.toString()};
    const real = ${JSON.stringify(real)};
    const review = ${JSON.stringify(REVIEW)};
    window.__timeline = ${JSON.stringify(TIMELINE)};
    window.__decisions = [];
    window.__lease = [];
    window.__held = null;
    window.__actions = [];
    window.__extra = [];
    window.__card = card;
    window.__approved = false;
    window.__sent = [];
    window.__board = () => ({
      projects: [{ id: 'p1', name: 'Contigos · Julian' }, { id: real.projectId, name: real.projectName }],
      cards: [
        card({ conversationId: 'c1', sessionId: 'c1', column: 'needs-you', pendingReviews: window.__approved ? [] : [review] }),
        card({ conversationId: 'c2', sessionId: 'c2', title: 'Replace Syncthing', column: 'needs-you', turnRunning: false, autoRespondStop: { kind: 'stop-instruction', reason: 'A plan waits for approval' } }),
        { ...card({}), ...real, column: 'running', summary: 'Running the UI tests', autoRespondActive: true, controlledBy: window.__held },
        card({ conversationId: 'c4', sessionId: 'c4', title: 'Community Plus billing', summary: 'Reading the Stripe webhook handler' }),
        card({ conversationId: 'c5', sessionId: 'c5', title: 'Review counter fixed', column: 'review', turnRunning: false, summary: 'Fixed and tested' }),
        ...window.__extra,
      ].filter((entry) => entry.column !== 'needs-you' || entry.pendingReviews.length || entry.autoRespondStop),
    });
    window.fetch = async (...args) => {
      const path = new URL(String(args[0]), location.href).pathname;
      const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (path === '/api/control-center/board') return reply(window.__board());
      if (path === '/api/control-center/summary') return reply({ waiting: 2 });
      if (path === '/api/control-center/guardian/decide') {
        window.__decisions.push(JSON.parse(args[1].body));
        window.__approved = true;
        return reply({ ok: true });
      }
      if (path === '/api/control-center/lease') {
        const body = JSON.parse(args[1].body);
        window.__lease.push(body.action);
        window.__held = body.action === 'take' ? 'you' : null;
        return reply({ leased: body.action === 'take' });
      }
      if (path === '/api/control-center/bob/messages') return reply({ messages: window.__timeline, waiting: 2 });
      if (path === '/api/control-center/bob/action') { window.__actions.push(JSON.parse(args[1].body)); return reply({ messages: [] }); }
      if (path === '/api/control-center/bob/message') {
        const body = JSON.parse(args[1].body);
        window.__sent.push(body);
        const make = (role, text) => ({ id: 'm' + window.__timeline.length, role, text, via: null, importance: 'fyi', actions: [], createdAt: new Date().toISOString(), projectId: body.projectId ?? null, projectName: body.projectId ? 'Contigos · Julian' : null });
        const user = make('user', body.message);
        const answer = make('bob', 'Two agents are running.');
        window.__timeline.push(user, answer);
        return reply({ action: 'answer', user, reply: answer, projectId: body.projectId ?? null });
      }
      return originalFetch(...args);
    };
    window.dispatchEvent(new CustomEvent('control-center-changed'));
  })()`);

  // The entry: the Focus menu has a Control center tile (with the count of what waits), in every view.
  await page.getByTestId("focus-controls-button").click();
  await page.getByTestId("focus-control-center").waitFor({ state: "visible" });
  await page.getByTestId("focus-control-center").getByTestId("control-phone-waiting").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("focus-control-center").getByTestId("control-phone-waiting").textContent(), "2", "the entry shows how many things wait for you");
  await page.getByTestId("focus-control-center").click();
  await page.locator("body.view-control").waitFor();

  // Only the chat shows: no board, no tabs, no desktop header, and the chat takes the whole screen.
  await page.getByTestId("control-phone-chip-ok").waitFor();
  assert.equal(await page.getByTestId("control-chat").isVisible(), true);
  for (const hidden of ["control-center-board", "control-center-tabs", "control-center-close-button", "control-chat-resize", "control-chat-side"]) {
    assert.equal(await page.getByTestId(hidden).isVisible(), false, `${hidden} is not shown on a phone`);
  }
  const chat = (await page.getByTestId("control-chat").boundingBox())!;
  assert.ok(chat.width >= 359 && chat.x <= 1, `the chat fills the screen: ${JSON.stringify(chat)}`);
  assert.equal(await page.getByTestId("focus-control-center").isVisible(), false, "the entry is not offered inside the control center");

  // The header shows Bob's state; the composer has the project and agent chips, and send.
  assert.equal(await page.getByTestId("control-chat-monitor").textContent(), "Monitoring");
  assert.equal(await page.getByTestId("control-phone-back").isVisible(), true);
  assert.equal(await page.getByTestId("control-chat-project").isVisible(), true);
  assert.equal(await page.getByTestId("control-phone-agent").isVisible(), true);
  assert.equal(await page.getByTestId("control-chat-send").isVisible(), true);
  assert.equal(await page.getByTestId("control-chat-input").isVisible(), true);

  // The chips count what waits and what runs, from the board.
  const chipTexts = await page.getByTestId("control-phone-strip").locator("button").allTextContents();
  assert.deepEqual(chipTexts, ["1 needs your OK", "1 needs you", "2 running", "1 to review", "▦ Dashboards"]);

  // Approvals and questions are cards in the timeline with buttons a thumb can reach.
  const entries = page.getByTestId("control-chat-entry");
  await entries.first().waitFor();
  assert.equal(await entries.count(), 2);
  const approval = entries.first();
  assert.match(await approval.innerText(), /Needs OK[\s\S]*aws ecs update-service/);
  assert.equal(await approval.evaluate((element) => getComputedStyle(element).borderTopStyle), "solid", "an approval is drawn as a card");
  const allowOnce = approval.getByRole("button", { name: "Allow once" });
  assert.ok((await allowOnce.boundingBox())!.height >= 34, "buttons are big enough to tap");
  await allowOnce.click();
  await page.waitForFunction("window.__actions.length === 1");
  assert.deepEqual(await page.evaluate("window.__actions"), [{ messageId: "g1", actionId: "guardian.allow" }]);

  // The sheet: rows grouped by what they need, each with its one action; it covers the lower part of the chat, not the page.
  await page.getByTestId("control-phone-chip-running").click();
  await page.getByTestId("control-phone-sheet").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("control-phone-chip-running").getAttribute("aria-pressed"), "true");
  assert.deepEqual(await page.getByTestId("control-phone-list").locator("[data-testid^=control-phone-group-]").allTextContents().then((texts) => texts.map((text) => text.replace(/\s+/g, " ").trim())), ["Needs your OK 1", "Needs you 1", "Running 2", "To review 1"]);
  const rows = page.getByTestId("control-phone-row");
  assert.equal(await rows.count(), 5);
  assert.equal(await page.locator('[data-testid="control-phone-row"][data-group="ok"]').getByTestId("control-phone-allow").count(), 1);
  assert.equal(await page.locator('[data-testid="control-phone-row"][data-group="ok"]').getByTestId("control-phone-block").count(), 1);
  assert.match(await page.locator('[data-testid="control-phone-row"][data-group="ok"]').innerText(), /aws ecs update-service --force-new-deployment/);
  assert.equal(await page.locator('[data-group="you"]').getByTestId("control-phone-answer").count(), 1);
  assert.match(await page.locator('[data-group="you"]').innerText(), /A plan waits for approval/);
  assert.equal(await page.locator('[data-group="review"]').getByTestId("control-phone-review").count(), 1);
  assert.equal(await page.locator(`[data-key="${real.projectId}:${real.conversationId}"]`).getByTestId("control-phone-watch").count(), 1);
  assert.equal(await page.locator(`[data-key="${real.projectId}:${real.conversationId}"]`).getByTestId("control-phone-take-control").count(), 1);
  const list = page.getByTestId("control-phone-list");
  assert.equal(await list.evaluate((element) => element.scrollHeight <= element.clientHeight), true, "the sheet pages instead of scrolling");
  const none = await sideways(page);
  assert.deepEqual(none, { page: 0, chat: 0, outside: [] }, "nothing sticks out sideways with the sheet open");

  // Answering a review from the sheet is the Guardian decision the board's button makes.
  await page.locator('[data-group="ok"]').getByTestId("control-phone-allow").click();
  await page.waitForFunction("window.__decisions.length === 1");
  assert.deepEqual(await page.evaluate("window.__decisions"), [{ projectId: "p1", conversationId: "c1", reviewId: "r1", decision: "allow" }]);
  await page.getByTestId("control-phone-chip-ok").waitFor({ state: "detached" });
  assert.equal(await page.locator('[data-group="ok"]').count(), 0, "the answered review leaves the sheet");
  assert.equal(await rows.count(), 4);

  // Escape closes the sheet before it can leave the control center.
  await page.keyboard.press("Escape");
  await page.getByTestId("control-phone-sheet").waitFor({ state: "hidden" });
  assert.equal(await page.locator("body.view-control").count(), 1);

  // Take control opens the conversation over the chat, with the banner and its message box, and closes the sheet.
  await page.getByTestId("control-phone-chip-running").click();
  await page.locator(`[data-key="${real.projectId}:${real.conversationId}"]`).getByTestId("control-phone-take-control").click();
  await page.getByTestId("control-lease-banner").waitFor({ state: "visible" });
  assert.equal(await page.locator("body.view-control.control-popup").count(), 1, "the conversation is open over the control center");
  await page.locator("#composer").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("control-phone-sheet").isVisible(), false);
  assert.deepEqual(await page.evaluate("window.__lease"), ["take"]);

  // Closing it gives it back to Bob.
  await page.getByTestId("control-popup-close").click();
  await page.getByTestId("control-popup-bar").waitFor({ state: "hidden" });
  await page.waitForFunction(() => (window as unknown as { __lease: string[] }).__lease.length === 2);
  assert.deepEqual(await page.evaluate("window.__lease"), ["take", "release"]);
  await page.getByTestId("control-phone-chip-running").click();
  const mine = page.locator(`[data-key="${real.projectId}:${real.conversationId}"]`);
  await mine.getByTestId("control-phone-take-control").waitFor();

  // Watch opens the conversation without taking control, and without a message box.
  await mine.getByTestId("control-phone-watch").click();
  await page.getByTestId("control-popup-bar").waitFor({ state: "visible" });
  assert.equal(await page.locator("#composer").isVisible(), false);
  assert.deepEqual(await page.evaluate("window.__lease"), ["take", "release"]);
  await page.getByTestId("control-popup-close").click();
  await page.getByTestId("control-popup-bar").waitFor({ state: "hidden" });
  assert.equal(await page.locator("body.view-control").count(), 1);

  // Many agents: the sheet pages to the height it has instead of scrolling, and a page that starts mid-group repeats its heading.
  await page.evaluate(`(() => {
    window.__extra = Array.from({ length: 14 }, (_, index) => window.__card({ conversationId: 'x' + index, sessionId: 'x' + index, title: 'Agent number ' + index, summary: 'Working on step ' + index }));
    window.dispatchEvent(new CustomEvent('control-center-changed'));
  })()`);
  await page.waitForFunction(() => document.querySelector('[data-testid="control-phone-chip-running"]')?.getAttribute("data-count") === "16");
  await page.getByTestId("control-phone-chip-running").click();
  await page.getByTestId("control-phone-pager").waitFor({ state: "visible" });
  const label = await page.getByTestId("control-phone-page-label").textContent();
  const pages = Number(/of (\d+)/.exec(label ?? "")![1]);
  assert.ok(pages >= 2, `sixteen running agents need more than one page: ${label}`);
  assert.equal(await list.evaluate((element) => element.scrollHeight <= element.clientHeight), true);
  assert.deepEqual(await sideways(page), { page: 0, chat: 0, outside: [] });
  await page.getByTestId("control-phone-next").click();
  assert.match((await page.getByTestId("control-phone-page-label").textContent()) ?? "", /Page 2 of/);
  assert.match(await page.getByTestId("control-phone-group-running").innerText(), /running/i, "the next page names its group again");
  assert.ok(await page.getByTestId("control-phone-row").count() > 0, "the next page has rows");
  assert.equal(await list.evaluate((element) => element.scrollHeight <= element.clientHeight), true);
  await page.getByTestId("control-phone-sheet-close").click();
  await page.getByTestId("control-phone-sheet").waitFor({ state: "hidden" });

  // The agent chip opens Bob's settings; the settings panel fits the screen.
  await page.getByTestId("control-phone-agent").click();
  await page.getByTestId("control-chat-settings").waitFor({ state: "visible" });
  assert.deepEqual(await sideways(page), { page: 0, chat: 0, outside: [] });
  await page.getByTestId("control-phone-agent").click();
  await page.getByTestId("control-chat-settings").waitFor({ state: "hidden" });

  // Dashboards cover the chat, with the way back.
  await page.getByTestId("control-phone-chip-dashboards").click();
  await page.getByTestId("control-dashboards-list").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("control-phone-view-title").textContent(), "Dashboards");
  assert.equal(await page.getByTestId("control-chat-input").evaluate((input) => {
    const box = input.getBoundingClientRect();
    return Boolean(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest("#controlViews"));
  }), true, "the dashboards view covers the chat");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
  // "Ask Bob for a dashboard" writes into the message box, so it brings the chat forward.
  await page.getByTestId("control-dashboards-new").click();
  await page.getByTestId("control-phone-view-back").waitFor({ state: "hidden" });
  assert.equal(await page.getByTestId("control-chat-input").inputValue(), "Create a dashboard for ");
  assert.equal(await page.getByTestId("control-dashboards-list").isVisible(), false);
  await page.getByTestId("control-chat-input").fill("");
  await page.getByTestId("control-phone-chip-dashboards").click();
  await page.getByTestId("control-dashboards-list").waitFor({ state: "visible" });
  await page.getByTestId("control-phone-view-back").click();
  await page.getByTestId("control-dashboards-list").waitFor({ state: "hidden" });

  // Sending reaches Bob with the chosen project.
  await page.getByTestId("control-chat-project").selectOption({ label: "Contigos · Julian" });
  await page.getByTestId("control-chat-input").fill("what is running?");
  await page.getByTestId("control-chat-send").click();
  await page.getByTestId("control-chat-messages").getByText("Two agents are running.").waitFor();
  const sent = await page.evaluate("window.__sent") as Array<{ message: string; projectId: string; appearance?: { settings: unknown } }>;
  assert.deepEqual(sent.map(({ message, projectId }) => ({ message, projectId })), [{ message: "what is running?", projectId: "p1" }]);
  assert.ok(sent[0].appearance?.settings, "the display settings go along, for Bob's display agent");

  // The back button leaves the control center, and the app icon's shortcut comes straight to it.
  await page.getByTestId("control-phone-back").click();
  assert.equal(await page.locator("body.view-control").count(), 0);
  await page.waitForFunction(async () => (await (await fetch("/api/preferences")).json()).mobileView !== "control");
  await page.goto(`${node.url}/?action=control-center`);
  await page.locator("body.view-control").waitFor();
  await page.getByTestId("control-phone-strip").waitFor({ state: "visible" });
  assert.deepEqual(errors, []);
});

test("a screen between a phone and a desktop reaches the control center from the app menu, and keeps it when the window changes", { timeout: 240_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node, environment);

  // On a desktop the board and Bob sit side by side, as before.
  await page.getByTestId("projects-open-control-center-button").click();
  await page.getByTestId("control-center-board").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("control-phone-strip").isVisible(), false, "the phone strip is not shown on a desktop");
  assert.equal(await page.getByTestId("control-phone-back").isVisible(), false);
  assert.equal(await page.getByTestId("control-center-tabs").isVisible(), true);

  // Narrowing the window keeps the control center and turns it into Bob's chat.
  await page.setViewportSize({ width: 820, height: 900 });
  await page.getByTestId("control-phone-strip").waitFor({ state: "visible" });
  assert.equal(await page.locator("body.view-control").count(), 1);
  assert.equal(await page.getByTestId("control-center-board").isVisible(), false);
  assert.equal(await page.getByTestId("control-chat-input").isVisible(), true);
  const head = (await page.locator(".control-chat-head").boundingBox())!;
  const menu = (await page.getByTestId("app-menu-button").boundingBox())!;
  const monitor = (await page.getByTestId("control-chat-monitor").boundingBox())!;
  assert.ok(monitor.x + monitor.width <= menu.x, `the header does not run under the app menu: ${JSON.stringify({ head, menu, monitor })}`);
  const navigation = (await page.locator(".mobile-nav").boundingBox())!;
  const panel = (await page.locator("#controlCenterPanel").boundingBox())!;
  assert.ok(panel.y + panel.height <= navigation.y, "the chat ends above the bottom navigation");
  assert.deepEqual(await sideways(page), { page: 0, chat: 0, outside: [] });

  // From the app menu on that screen.
  await page.getByTestId("control-phone-back").click();
  assert.equal(await page.locator("body.view-control").count(), 0);
  await page.getByTestId("app-menu-button").click();
  await page.getByTestId("app-menu-control-center-button").click();
  await page.locator("body.view-control").waitFor();
  assert.equal(await page.locator("#appMenu[open]").count(), 0, "the menu closes");

  // Back to a desktop: the board is there again.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId("control-center-board").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("control-phone-strip").isVisible(), false);
});
