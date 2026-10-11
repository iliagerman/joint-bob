import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

type WidthReport = { width: number; wrapped: boolean; clipped: number; moved: string[] };

/**
 * The toolbar used to size itself from its labels, so a model name, a task count or
 * the reasoning picker arriving re-wrapped the action row and shifted the whole
 * conversation by a row. Each change here goes through the code that makes it in
 * the app; the DOM is only touched for the task count, which has no state to set.
 */
const MEASURE_LABEL_CHANGES = `(async () => {
  const { state } = await import('/app/state.js');
  const { renderReasoningOptions, syncModelButton } = await import('/app/composer-dialogs.js');
  const { renderChatSessionControls } = await import('/app/chat-controls.js');
  const { setStatus } = await import('/app/shell.js');
  const toolbar = document.querySelector('#chatToolbar');
  const actions = toolbar.querySelector('.chat-toolbar-actions');
  const badge = document.querySelector('#backgroundTasksBadge');
  const status = document.querySelector('#connectionStatus');
  const read = () => {
    const first = actions.querySelector('button:not([hidden])').getBoundingClientRect();
    return {
      conversationTop: Math.round(document.querySelector('#messages').getBoundingClientRect().top),
      toolbarHeight: Math.round(toolbar.getBoundingClientRect().height),
      actionLeft: Math.round(first.left),
      actionTop: Math.round(first.top),
    };
  };
  const saved = {
    label: state.activeModelLabel, key: state.activeModelKey, routing: state.routing,
    levels: state.availableThinkingLevels, level: state.thinkingLevel, nodes: state.sessionNodes, status: status.textContent,
  };
  const model = (label) => () => { state.activeModelKey = ''; state.activeModelLabel = label; syncModelButton(); };
  const changes = {
    'model name not loaded yet': model(''),
    'short model name': model('Sol'),
    'long model name': model('anthropic/claude-opus-5-5-extended-thinking-preview'),
    'Bob auto routing': () => { state.routing = { active: true, mode: 'auto' }; syncModelButton(); renderReasoningOptions(); },
    'model without reasoning levels': () => { state.availableThinkingLevels = []; renderReasoningOptions(); },
    'model with reasoning levels': () => { state.availableThinkingLevels = ['minimal', 'low', 'medium', 'high', 'xhigh']; state.thinkingLevel = 'minimal'; renderReasoningOptions(); },
    'one running task': () => { badge.hidden = false; badge.textContent = '1'; },
    'many running tasks': () => { badge.hidden = false; badge.textContent = '99+'; },
    'execution node goes offline': () => {
      state.sessionNodes = [...saved.nodes.map((node) => ({ ...node })), { id: 'peer', name: 'A second node with a long name', online: false, mapped: true }];
      renderChatSessionControls();
    },
    'agent working': () => setStatus('Claude Code is working', true),
    'background tasks running': () => setStatus('Background tasks running', true),
  };
  const restore = () => {
    state.activeModelLabel = saved.label; state.activeModelKey = saved.key; state.routing = saved.routing;
    state.availableThinkingLevels = saved.levels; state.thinkingLevel = saved.level; state.sessionNodes = saved.nodes;
    badge.hidden = true; badge.textContent = '';
    setStatus(saved.status, true);
    syncModelButton(); renderReasoningOptions(); renderChatSessionControls();
  };
  restore();
  const resting = read();
  const moved = [];
  for (const [name, apply] of Object.entries(changes)) {
    apply();
    const next = read();
    for (const key of Object.keys(resting)) if (next[key] !== resting[key]) moved.push(name + ': ' + key + ' ' + resting[key] + ' -> ' + next[key]);
    restore();
  }
  const bar = toolbar.getBoundingClientRect();
  const group = actions.getBoundingClientRect();
  const controls = document.querySelector('#chatNodeSelect').getBoundingClientRect();
  return { wrapped: group.top >= controls.bottom - 2, clipped: Math.max(0, Math.round(group.right - bar.right)), moved };
})()`;

test("the chat toolbar holds still while its labels change", { timeout: 180_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length === 3);
  await page.locator("#projectList .list-row", { hasText: "Internal Assistant" }).locator("button").first().click();
  await page.locator('[data-filter="all"]').click();
  await page.locator("#sessionList .session-card", { hasText: "Thread-Based Agent Builder" }).click();
  await page.locator("#modelButton:enabled").waitFor();
  await page.locator("#messages .message").first().waitFor();

  // Every desktop width, in steps small enough that no wrap point falls between two of them.
  const reports: WidthReport[] = [];
  for (let width = 1024; width <= 2000; width += 8) {
    await page.setViewportSize({ width, height: 900 });
    reports.push({ width, ...await page.evaluate(MEASURE_LABEL_CHANGES) as Omit<WidthReport, "width"> });
  }

  const moved = reports.filter((report) => report.moved.length);
  assert.deepEqual(moved.map((report) => `${report.width}px: ${report.moved.join("; ")}`).slice(0, 12), [],
    `a label change moved the toolbar or the conversation at ${moved.length} of ${reports.length} widths`);

  const clipped = reports.filter((report) => report.clipped > 0);
  assert.deepEqual(clipped.map((report) => `${report.width}px: ${report.clipped}px`), [], "the action buttons run past the panel edge");

  // Room is a property of the window: narrow panels stack the actions, wide ones do not,
  // and there is one width where that changes rather than a band that flips back and forth.
  assert.equal(reports[0].wrapped, true, "a narrow panel puts the actions on their own row");
  assert.equal(reports.at(-1)!.wrapped, false, "a wide panel keeps the actions beside the selects");
  const switches = reports.filter((report, index) => index > 0 && report.wrapped !== reports[index - 1].wrapped);
  assert.deepEqual(switches.map((report) => report.width), switches.slice(0, 1).map((report) => report.width),
    "the actions change rows at exactly one width");
});
