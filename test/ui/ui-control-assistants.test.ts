import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { waitInPage } from "./wait-in-page.js";

/** The board and the assistants routes are stand-ins the test steers; everything else is the real server's. */
async function mockRoutes(page: Page, board: unknown): Promise<void> {
  await page.evaluate(`(() => {
    const originalFetch = window.fetch;
    const json = { 'content-type': 'application/json' };
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: json });
    window.__calls = [];
    window.__assistants = [];
    window.__asks = {};
    window.__transcript = {};
    window.__turnDelay = 0;
    window.fetch = async (...args) => {
      const path = new URL(String(args[0]), location.href).pathname;
      const method = (args[1]?.method ?? 'GET').toUpperCase();
      if (path === '/api/control-center/board') return reply(${JSON.stringify(board)});
      if (path === '/api/control-center/assistants' && method === 'GET') return reply({ assistants: window.__assistants });
      let found = /^\\/api\\/control-center\\/assistants\\/([^/]+)\\/may-ask$/.exec(path);
      if (found && method === 'PUT') {
        const { enabled } = JSON.parse(args[1].body);
        window.__calls.push({ kind: 'may-ask', id: found[1], enabled });
        const card = window.__assistants.find((candidate) => candidate.id === found[1]);
        if (card.shared && enabled) return reply({ error: 'shared' }, 409);
        card.mayAsk = enabled;
        card.askable = enabled && !card.shared;
        if (!card.shared) card.reason = enabled ? null : 'Bob may not ask it: the switch is off.';
        return reply({ assistant: card });
      }
      found = /^\\/api\\/control-center\\/assistants\\/([^/]+)\\/asks$/.exec(path);
      if (found && method === 'GET') return reply({ asks: window.__asks[found[1]] ?? [] });
      found = /^\\/api\\/personal-assistants\\/([^/]+)\\/transcript$/.exec(path);
      if (found && method === 'GET') return reply({ timeline: window.__transcript[found[1]] ?? [] });
      found = /^\\/api\\/personal-assistants\\/([^/]+)\\/turn$/.exec(path);
      if (found && method === 'POST') {
        const body = JSON.parse(args[1].body);
        window.__calls.push({ kind: 'turn', id: found[1], requestId: body.requestId, message: body.message, recent: body.recentMessages.length });
        await new Promise((resolve) => setTimeout(resolve, window.__turnDelay));
        const at = new Date().toISOString();
        window.__transcript[found[1]] = [...(window.__transcript[found[1]] ?? []), { id: body.requestId, role: 'user', text: body.message, createdAt: at }, { id: body.requestId + ':response', role: 'assistant', text: 'Done: **' + body.message + '**', createdAt: at }];
        return reply({ turn: { requestId: body.requestId, status: 'completed' } }, 200);
      }
      return originalFetch(...args);
    };
  })()`);
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function cards() {
  const base = { local: true, state: "idle", isDefault: false, mayAsk: true, askable: true, shared: false, reason: null, lastAsk: null, askedLastDay: 0, about: "", nodeId: "n1" };
  return [
    { ...base, id: "p", name: "Personal assistant", machine: "Mac", isDefault: true, has: ["Google calendar", "Gmail", "WhatsApp login", "Telegram"], askedLastDay: 3,
      lastAsk: { id: "a1", helperId: "p", helperName: "Personal assistant", purpose: "Google calendar, Gmail", status: "completed", question: "What's on Ilia's calendar tomorrow? Titles and times.", answer: "09:30 dentist, 13:00 lunch with Dana", error: null, startedAt: minutesAgo(10), finishedAt: minutesAgo(10), seconds: 3 } },
    { ...base, id: "m", name: "Marketing agent", machine: "Homeserver", local: false, state: "answering-bob", has: ["LinkedIn login", "Canva MCP"], askedLastDay: 1,
      lastAsk: { id: "a2", helperId: "m", helperName: "Marketing agent", purpose: "LinkedIn login", status: "running", question: "Is the 2.212 launch post ready?", answer: null, error: null, startedAt: minutesAgo(0), finishedAt: null, seconds: null } },
    { ...base, id: "w", name: "Work assistant", machine: "Mac", has: ["Work calendar"] },
    { ...base, id: "s", name: "Shopping assistant", machine: "Homeserver", local: false, has: [], shared: true, askable: false,
      reason: "Shopping assistant is in a shared project, so Bob can't ask it: its answers could reach the people it is shared with." },
  ];
}

async function open(t: test.TestContext) {
  const fixture = await nativeUiFixture(t);
  const { page, environment, node } = fixture;
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length === 3 && !document.body.classList.contains("booting"));
  await waitInPage(page, async () => (await import("/app/state.js")).state.preferencesLoaded);
  await page.waitForTimeout(500);
  const [first] = node.projects;
  await mockRoutes(page, { projects: [{ id: first.id, name: first.name }], cards: [] });
  await page.evaluate((assistants) => { (window as any).__assistants = assistants; }, cards());
  await page.getByTestId("projects-open-control-center-button").click();
  return page;
}

const names = (page: Page) => page.getByTestId("control-assistants-list").getByTestId("control-assistant-card").evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.name));
const calls = (page: Page) => page.evaluate(() => (window as any).__calls as Array<Record<string, unknown>>);
const card = (page: Page, name: string) => page.getByTestId("control-assistants-list").locator(`[data-testid="control-assistant-card"][data-name="${name}"]`);

test("the Assistants tab lists the person's assistants with what they have, the last ask and Bob's switch; a click opens the assistant's chat", { timeout: 240_000 }, async (t) => {
  const page = await open(t);
  await page.getByTestId("control-tab-assistants").click();
  await page.getByTestId("control-assistants-list").getByTestId("control-assistant-card").first().waitFor();
  assert.equal(await page.getByTestId("control-tab-assistants").locator(".control-tab-badge").innerText(), "4", "the tab counts the assistants");
  assert.deepEqual(await names(page), ["Personal assistant", "Marketing agent", "Work assistant", "Shopping assistant"]);
  assert.equal(await page.getByTestId("control-assistants-rail").isVisible(), false, "below 1700 px there is only the tab");
  assert.equal(await page.getByTestId("control-assistants-list").getByText("Ask", { exact: true }).count(), 0, "no ask buttons: the person asks Bob");
  assert.equal(await page.getByTestId("control-assistants-list").getByRole("button", { name: /^Ask/ }).count(), 0);

  const personal = card(page, "Personal assistant");
  assert.match(await personal.getByTestId("control-assistant-where").innerText(), /Mac · idle/);
  assert.deepEqual(await personal.getByTestId("control-assistant-has").locator("span").allInnerTexts(), ["Google calendar", "Gmail", "WhatsApp login", "+1"]);
  assert.match(await personal.getByTestId("control-assistant-last").innerText(), /^Bob asked “What's on Ilia's calendar tomorrow\? Titles and times\.” · 3 s · 10m ago$/);
  assert.match(await personal.locator(".control-badge").innerText(), /default/);
  assert.equal(await personal.getByTestId("control-assistant-switch").getAttribute("aria-checked"), "true");

  const marketing = card(page, "Marketing agent");
  assert.match(await marketing.getByTestId("control-assistant-where").innerText(), /Homeserver · answering Bob/);
  assert.equal(await marketing.getAttribute("data-state"), "answering-bob");
  assert.match(await marketing.getByTestId("control-assistant-last").innerText(), /^Bob is asking “Is the 2\.212 launch post ready\?”$/);
  assert.match(await card(page, "Work assistant").getByTestId("control-assistant-last").innerText(), /^Bob has not asked it yet\.$/);

  // An assistant whose project is shared can't be asked, and says why; its switch can't be turned on.
  const shopping = card(page, "Shopping assistant");
  assert.match(await shopping.getByTestId("control-assistant-last").innerText(), /is in a shared project, so Bob can't ask it/);
  assert.equal(await shopping.getByTestId("control-assistant-switch").getAttribute("aria-checked"), "false");
  assert.equal(await shopping.getByTestId("control-assistant-switch").isDisabled(), true);
  assert.equal(await shopping.getAttribute("data-askable"), "false");

  // The switch is Bob's "may ask"; it is the server's answer that is drawn.
  const work = card(page, "Work assistant");
  await work.getByTestId("control-assistant-switch").click();
  await page.waitForFunction(() => document.querySelector('[data-name="Work assistant"]')?.getAttribute("data-askable") === "false");
  assert.deepEqual((await calls(page)).filter((call) => call.kind === "may-ask"), [{ kind: "may-ask", id: "w", enabled: false }]);
  assert.match(await work.getByTestId("control-assistant-last").innerText(), /^Bob may not ask it: the switch is off\.$/);
  assert.equal(await page.locator("dialog[open]").count(), 0, "turning the switch does not open the chat");
  await work.getByTestId("control-assistant-switch").click();
  await page.waitForFunction(() => document.querySelector('[data-name="Work assistant"]')?.getAttribute("data-askable") === "true");

  // News from the server (an ask began or ended) redraws the cards without a reload.
  await page.evaluate(() => {
    const work = (window as any).__assistants.find((candidate: { id: string }) => candidate.id === "w");
    work.state = "busy";
    window.dispatchEvent(new CustomEvent("control-center-changed"));
  });
  await page.waitForFunction(() => document.querySelector('[data-name="Work assistant"]')?.getAttribute("data-state") === "busy");
  assert.match(await work.getByTestId("control-assistant-where").innerText(), /Mac · busy/);
});

test("the cards fit the height and page instead of scrolling", { timeout: 240_000 }, async (t) => {
  const page = await open(t);
  const many = Array.from({ length: 40 }, (_, index) => ({ ...cards()[2], id: `h${index}`, name: `Helper ${String(index).padStart(2, "0")}` }));
  await page.evaluate((assistants) => { (window as any).__assistants = assistants; window.dispatchEvent(new CustomEvent("control-center-changed")); }, many);
  await page.getByTestId("control-tab-assistants").click();
  await page.getByTestId("control-assistants-pager").getByTestId("control-assistants-next").waitFor();
  const list = page.getByTestId("control-assistants-list");
  const fits = () => list.evaluate((node) => node.scrollHeight <= node.clientHeight + 1 && node.scrollWidth <= node.clientWidth + 1);
  assert.equal(await fits(), true, "nothing to scroll");
  const first = await names(page);
  assert.ok(first.length > 0 && first.length < 40, `a page holds ${first.length}`);
  assert.equal(first[0], "Helper 00");
  assert.match(await page.getByTestId("control-assistants-page-label").innerText(), new RegExp(`^1 / ${Math.ceil(40 / first.length)}$`));
  await page.getByTestId("control-assistants-next").click();
  const second = await names(page);
  assert.equal(second[0], `Helper ${String(first.length).padStart(2, "0")}`);
  assert.equal(await fits(), true);
  assert.equal(await page.getByTestId("control-assistants-prev").isEnabled(), true);
  assert.equal(await page.getByTestId("control-tab-assistants").locator(".control-tab-badge").innerText(), "40");
});

test("an assistant's chat opens over the board: its conversation with Bob's asks marked, what it has, and a direct message to it", { timeout: 240_000 }, async (t) => {
  const page = await open(t);
  await page.evaluate(() => {
    const w = window as any;
    w.__transcript.p = [
      { id: "t1", role: "user", text: "remind me to call the bank on Thursday", createdAt: new Date(Date.now() - 3_600_000).toISOString() },
      { id: "t2", role: "assistant", text: "Added for **Thursday 10:00**.", createdAt: new Date(Date.now() - 3_599_000).toISOString() },
      { id: "t3", role: "user", text: "thanks", createdAt: new Date(Date.now() - 300_000).toISOString() },
    ];
    w.__asks.p = [{ id: "a1", helperId: "p", helperName: "Personal assistant", purpose: "Google calendar, Gmail", status: "completed", question: "What's on Ilia's calendar tomorrow? Titles and times.", answer: "09:30 dentist, 13:00 lunch with Dana", error: null, startedAt: new Date(Date.now() - 600_000).toISOString(), finishedAt: new Date(Date.now() - 597_000).toISOString(), seconds: 3 }];
  });
  await page.getByTestId("control-tab-assistants").click();
  await card(page, "Personal assistant").click();
  const dialog = page.getByTestId("control-assistant-dialog");
  await dialog.waitFor();
  await page.getByTestId("control-assistant-timeline").getByTestId("control-assistant-bob-ask").waitFor();
  assert.equal(await page.getByTestId("control-assistant-title").innerText(), "Personal assistant");
  assert.match(await page.getByTestId("control-assistant-chat-where").innerText(), /Mac · idle/);

  // The conversation, with what Bob asked in the order it happened.
  const order = await page.getByTestId("control-assistant-timeline").locator("> *").evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.testid + ":" + (node.textContent ?? "").slice(0, 24)));
  assert.deepEqual(order.map((entry) => entry.split(":")[0]), ["control-assistant-message", "control-assistant-message", "control-assistant-bob-ask", "control-assistant-message"]);
  assert.equal(await page.getByTestId("control-assistant-message").nth(1).locator("strong").innerText(), "Thursday 10:00", "an answer is formatted");
  const bobAsk = page.getByTestId("control-assistant-bob-ask");
  assert.match(await bobAsk.locator("summary").innerText(), /^Bob asked · 10 min ago · 3 s$/);
  assert.equal(await bobAsk.evaluate((node) => (node as HTMLDetailsElement).open), false);
  assert.equal(await bobAsk.locator(".control-asst-bobq-q").isVisible(), false);

  // Beside the chat: what it has, and Bob's asks; a row shows that ask in the chat.
  const side = page.getByTestId("control-assistant-side");
  assert.deepEqual(await side.getByTestId("control-assistant-side-has").allInnerTexts(), ["Google calendar", "Gmail", "WhatsApp login", "Telegram"]);
  assert.match(await side.innerText(), /3 in the last day/);
  await side.getByTestId("control-assistant-ask-row").click();
  assert.equal(await bobAsk.evaluate((node) => (node as HTMLDetailsElement).open), true);
  assert.equal(await bobAsk.locator(".control-asst-bobq-q").innerText(), "What's on Ilia's calendar tomorrow? Titles and times.");
  assert.match(await bobAsk.locator(".control-asst-bobq-a").innerText(), /→ 09:30 dentist, 13:00 lunch with Dana/);

  // Messaging the assistant directly: the turn is sent once, the person sees it working, then the answer.
  await page.evaluate(() => { (window as any).__turnDelay = 1_500; });
  await page.getByTestId("control-assistant-input").fill("book the dentist");
  await page.getByTestId("control-assistant-send").click();
  await page.getByTestId("control-assistant-working").waitFor();
  assert.equal(await page.getByTestId("control-assistant-send").isDisabled(), true);
  assert.equal(await page.getByTestId("control-assistant-input").inputValue(), "");
  await page.getByTestId("control-assistant-message").filter({ hasText: "Done: book the dentist" }).waitFor();
  const turns = (await calls(page)).filter((call) => call.kind === "turn");
  assert.equal(turns.length, 1);
  assert.deepEqual([turns[0].id, turns[0].message, turns[0].recent], ["p", "book the dentist", 3]);
  assert.match(String(turns[0].requestId), /^[0-9a-f-]{36}$/);
  assert.equal(await page.getByTestId("control-assistant-send").isEnabled(), true);
  assert.equal(await page.getByTestId("control-assistant-working").count(), 0);

  // Bob's switch is in the chat too, and Esc closes the chat but leaves the control center open.
  await page.getByTestId("control-assistant-chat-switch").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="control-assistant-chat-switch"]')?.getAttribute("aria-checked") === "false");
  assert.match(await page.getByTestId("control-assistant-why").innerText(), /Bob may not ask it: the switch is off/);
  assert.equal(await card(page, "Personal assistant").getAttribute("data-askable"), "false", "the cards behind it follow");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.body.classList.contains("view-control")), true);
});

test("an assistant on another machine shows what Bob asked it but no composer; a shared one shows why Bob can't ask it", { timeout: 240_000 }, async (t) => {
  const page = await open(t);
  await page.evaluate(() => {
    (window as any).__asks.m = [{ id: "a2", helperId: "m", helperName: "Marketing agent", purpose: "LinkedIn login", status: "running", question: "Is the 2.212 launch post ready?", answer: null, error: null, startedAt: new Date().toISOString(), finishedAt: null, seconds: null }];
  });
  await page.getByTestId("control-tab-assistants").click();
  await card(page, "Marketing agent").click();
  await page.getByTestId("control-assistant-dialog").waitFor();
  await page.getByTestId("control-assistant-bob-ask").waitFor();
  assert.match(await page.getByTestId("control-assistant-chat-where").innerText(), /Homeserver · answering Bob now/);
  assert.equal(await page.getByTestId("control-assistant-form").isHidden(), true);
  assert.match(await page.getByTestId("control-assistant-remote-note").innerText(), /Marketing agent runs on Homeserver\. Open Joint Bob there/);
  assert.equal(await page.getByTestId("control-assistant-bob-ask").evaluate((node) => (node as HTMLDetailsElement).open), true, "an ask in progress is open");
  assert.match(await page.getByTestId("control-assistant-bob-ask").innerText(), /answering…/);
  assert.equal(await page.getByTestId("control-assistant-open-page").getAttribute("href"), "/assistant.html?id=m");
  await page.getByTestId("control-assistant-close").click();

  await card(page, "Shopping assistant").click();
  await page.getByTestId("control-assistant-dialog").waitFor();
  assert.match(await page.getByTestId("control-assistant-why").innerText(), /why bob can't ask it[\s\S]*shared project/i);
  assert.equal(await page.getByTestId("control-assistant-chat-switch").isDisabled(), true);
  assert.match(await page.getByTestId("control-assistant-side").innerText(), /Bob has not asked it yet\./);
});

test("from 1700 px the list is a column between the board and Bob's chat that folds away, on either side; the tab goes away", { timeout: 240_000 }, async (t) => {
  const page = await open(t);
  await page.getByTestId("control-tab-assistants").click();
  await page.getByTestId("control-assistants-list").getByTestId("control-assistant-card").first().waitFor();
  await page.setViewportSize({ width: 1800, height: 900 });
  const rail = page.getByTestId("control-assistants-rail");
  await rail.waitFor();
  assert.equal(await page.getByTestId("control-tab-assistants").isVisible(), false, "the column replaces the tab");
  assert.equal(await page.getByTestId("control-tab-live").getAttribute("aria-selected"), "true", "an open Assistants tab goes back to the board");
  assert.equal(await page.getByTestId("control-assistants-rail-count").innerText(), "4");
  await rail.getByTestId("control-assistant-card").first().waitFor();
  assert.equal(await rail.getByTestId("control-assistant-card").count(), 4);

  const box = async (selector: string) => (await page.locator(selector).boundingBox())!;
  const order = async () => {
    const [stage, column, chat] = [await box("#controlViews"), await box('[data-testid="control-assistants-rail"]'), await box("#controlChat")];
    return { stage, column, chat };
  };
  let { stage, column, chat } = await order();
  assert.ok(chat.x + chat.width <= column.x + 1 && column.x + column.width <= stage.x + 1, "Bob's chat on the left, then the assistants, then the board");
  await page.getByTestId("control-chat-side").click();
  ({ stage, column, chat } = await order());
  assert.ok(stage.x + stage.width <= column.x + 1 && column.x + column.width <= chat.x + 1, "still between them when Bob's chat is on the right");
  await page.getByTestId("control-chat-side").click();

  // The column folds to a strip and opens again.
  const before = (await box('[data-testid="control-assistants-rail"]')).width;
  await page.getByTestId("control-assistants-rail-toggle").click();
  assert.equal(await page.getByTestId("control-assistants-rail-toggle").getAttribute("aria-expanded"), "false");
  assert.ok((await box('[data-testid="control-assistants-rail"]')).width < before / 3);
  assert.equal(await rail.getByTestId("control-assistant-card").first().isVisible(), false);
  await page.getByTestId("control-assistants-rail-toggle").click();
  await rail.getByTestId("control-assistant-card").first().waitFor();
  assert.equal(await rail.getByTestId("control-assistant-card").count(), 4);

  // The column's cards do the same as the tab's.
  await rail.getByTestId("control-assistant-card").nth(2).getByTestId("control-assistant-switch").click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="control-assistants-rail"] [data-askable="false"]').length === 2);
  assert.deepEqual((await calls(page)).filter((call) => call.kind === "may-ask").map((call) => call.id), ["w"]);
  await rail.getByTestId("control-assistant-card").first().click();
  await page.getByTestId("control-assistant-dialog").waitFor();
  assert.equal(await page.getByTestId("control-assistant-title").innerText(), "Personal assistant");

  // Back to a narrower window: only the tab.
  await page.getByTestId("control-assistant-close").click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId("control-tab-assistants").waitFor();
  assert.equal(await rail.isVisible(), false);
});
