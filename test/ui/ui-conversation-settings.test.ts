import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";

const dialog = '[data-testid="conversation-classification-dialog"]';
const select = '[data-testid="conversation-classification-select"]';
const other = '[data-testid="conversation-classification-other"]';
const save = '[data-testid="conversation-classification-save-button"]';
const cancel = '[data-testid="conversation-classification-cancel-button"]';

async function openClassification(page: Page, engine: string) {
  await page.evaluate(`(async () => {
    const {state} = await import('/app/state.js');
    const session = state.sessions.find(session => session.harnessId === ${JSON.stringify(engine)} && !session.readOnly);
    window.classificationTarget = {id:session.id, path:session.path};
    session.running = true;
    (await import('/app/session-list.js')).renderSessions();
    document.querySelector('[data-session-path="' + CSS.escape(session.path) + '"] [data-testid="session-menu-button"]').click();
    return true;
  })()`);
  assert.equal(await page.evaluate('Boolean(document.querySelector(\'[data-testid="session-classification-button"]\'))'), true, "existing conversation actions must offer Classification");
  assert.equal(await page.evaluate('document.querySelector(\'[data-testid="session-fork-button"]\').disabled'), false, "running conversations must offer Fork conversation");
  await page.locator('[data-testid="session-classification-button"]').click();
  await page.locator(`${dialog}[open]`).waitFor();
}

async function assertSaved(page: Page, label: string | null) {
  await page.locator(save).click();
  await page.locator(`${dialog}[open]`).waitFor({ state: "hidden" });
  const state = await page.evaluateHandle(async () => (await import('/app/state.js')).state);
  await page.waitForFunction(({ state, label }) => {
    const session = state.sessions.find(session => session.id === window.classificationTarget.id);
    return (session.classification || null) === label;
  }, { state, label });
  await state.dispose();
  const badge = await page.evaluate(`document.querySelector('[data-session-path="' + CSS.escape(window.classificationTarget.path) + '"] [data-testid="session-classification"]')?.textContent || null`);
  assert.equal(badge, label, "saved classification must appear in the conversation row");
}

async function editExisting(page: Page, engine: string) {
  await openClassification(page, engine);
  assert.equal(await page.locator(select).inputValue(), "");
  await page.locator(select).selectOption("Bug");
  await assertSaved(page, "Bug");
  await openClassification(page, engine);
  assert.equal(await page.locator(select).inputValue(), "Bug", "reopening preselects current classification");
  await page.locator(select).selectOption("Feature");
  await page.locator(cancel).click();
  await openClassification(page, engine);
  assert.equal(await page.locator(select).inputValue(), "Bug", "Cancel must not save");
  await page.locator(select).selectOption("__other__");
  await page.locator(save).click();
  assert.equal(await page.evaluate(`document.querySelector('${dialog}').open`), true, "Other requires text");
  await page.locator(other).fill("Investigation <custom>");
  await page.evaluate(`(() => {
    const nativeFetch = window.fetch;
    window.restoreClassificationFetch = () => { window.fetch = nativeFetch; };
    window.fetch = (url, options) => String(url).endsWith('/sessions/classification') ? Promise.resolve(Response.json({error:'Classification save unavailable'}, {status:503})) : nativeFetch(url, options);
    return true;
  })()`);
  await page.locator(save).click();
  await page.getByText('Classification save unavailable', { exact: true }).waitFor();
  assert.equal(await page.evaluate(`document.querySelector('${dialog}').open && !document.querySelector('${save}').disabled`), true, "failed save keeps dialog editable");
  await page.evaluate('window.restoreClassificationFetch(); true');
  await assertSaved(page, "Investigation <custom>");
  await page.reload();
  await page.locator('#sessionList [data-testid="session-menu-button"]').first().waitFor();
  await openClassification(page, engine);
  assert.equal(await page.locator(select).inputValue(), "__other__");
  assert.equal(await page.locator(other).inputValue(), "Investigation <custom>", "custom label survives reload");
  await page.locator(select).selectOption("");
  await assertSaved(page, null);
}

async function signInAndOpenProject(page: Page, url: string, username: string, password: string) {
  await page.goto(url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.getByTestId("login-username-input").fill(username);
  await page.getByTestId("login-password-input").fill(password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#projectList .project-card", { hasText: "Internal Assistant" }).click();
  await page.locator('#sessionList [data-testid="session-menu-button"]').first().waitFor();
}

test("existing conversations can change and clear classifications through their row menu", { timeout: 240_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signInAndOpenProject(page, node.url, environment.username, environment.password);
  for (const engine of ["pi", "claude"]) await editExisting(page, engine);
  await page.evaluate(`(async () => {
    const {state} = await import('/app/state.js');
    const session = state.sessions.find(session => session.harnessId === 'pi');
    session.readOnly = true;
    (await import('/app/session-list.js')).renderSessions();
    document.querySelector('[data-session-path="' + CSS.escape(session.path) + '"] [data-testid="session-menu-button"]').click();
    return true;
  })()`);
  assert.equal(await page.evaluate('Boolean(document.querySelector(\'[data-testid="session-classification-button"]\'))'), false, "read-only conversations must not offer classification edits");
});

async function configureHarnessDefaults(page: Page) {
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-engines").click();
  assert.deepEqual(await page.evaluate(`['Pi', 'Claude'].map(harness => document.querySelector('#settings' + harness + 'DefaultThinking')?.value)`), ["medium", "medium"], "both harnesses need editable medium defaults");
  await page.getByTestId("settings-pi-default-provider").fill("anthropic");
  await page.getByTestId("settings-pi-default-model").fill("claude-sonnet-4-5");
  await page.locator("#settingsPiDefaultThinking").selectOption("low");
  await page.getByTestId("harness-tab-claude").click();
  await page.getByTestId("settings-claude-default-model").fill("sonnet");
  await page.locator("#settingsClaudeDefaultThinking").selectOption("high");
  await page.getByTestId("settings-save-button").click();
  await page.locator('#settingsDialog[open]').waitFor({ state: "hidden" });
  assert.deepEqual(await page.evaluate('(async () => (await (await fetch("/api/settings")).json()).conversationDefaults)()'), {
    pi: { provider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevel: "low" },
    claude: { provider: "claude", modelId: "sonnet", thinkingLevel: "high" },
  });
}

async function assertNewConversationDefaults(page: Page, engine: string, model: string, thinking: string) {
  await page.getByTestId(engine === "pi" ? "session-create-button" : "session-create-claude-button").click();
  await page.getByTestId("new-session-name-input").fill(`${engine} defaults check`);
  await page.getByTestId("new-session-name-start-button").click();
  const state = await page.evaluateHandle(async () => (await import('/app/state.js')).state);
  await page.waitForFunction(({ state, engine, thinking, model }) => {
    return state.activeSessionId && state.engine === engine && state.thinkingLevel === thinking && state.activeModelKey === model;
  }, { state, engine, thinking, model });
  await state.dispose();
  const selectedModel = await page.evaluate(async () => (await import("/app/state.js")).state.activeModelKey);
  assert.equal(selectedModel, model, "new conversation uses the configured model");
}

test("Settings edit per-harness model and thinking defaults for new conversations", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signInAndOpenProject(page, node.url, environment.username, environment.password);
  await configureHarnessDefaults(page);
  await page.goto(node.url);
  await page.locator('#sessionList [data-testid="session-menu-button"]').first().waitFor();
  await page.getByTestId("settings-open-button").click();
  await page.locator('#settingsDialog[open]').waitFor();
  assert.equal(await page.locator("#settingsPiDefaultThinking").inputValue(), "low", "saved defaults survive reload");
  assert.equal(await page.locator("#settingsClaudeDefaultModel").inputValue(), "sonnet");
  await page.evaluate('document.querySelector("#settingsDialog").close(); true');
  await assertNewConversationDefaults(page, "pi", "anthropic/claude-sonnet-4-5", "low");
  await assertNewConversationDefaults(page, "claude", "claude/sonnet", "high");
});
