import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

const exec = promisify(execFile);
async function browser(...args: string[]) {
  if (!process.env.JOINT_BOB_BROWSER_CLI) throw new Error("Designated browser executor is required");
  const { stdout } = await exec(process.execPath, [process.env.JOINT_BOB_BROWSER_CLI, ...args], { timeout: 30_000 });
  return JSON.parse(stdout).result;
}
const dialog = '[data-testid="conversation-classification-dialog"]';
const select = '[data-testid="conversation-classification-select"]';
const other = '[data-testid="conversation-classification-other"]';
const save = '[data-testid="conversation-classification-save-button"]';
const cancel = '[data-testid="conversation-classification-cancel-button"]';

async function waitFor(expression: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await browser("evaluate", expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.fail(`Browser condition did not become true: ${expression}`);
}

async function startBrowser(url: string) {
  await browser("start");
  await browser("navigate", url);
  try {
    await waitFor('document.querySelector("#loginDialog")?.open === true');
  } catch (error) {
    const snapshot = await browser("snapshot");
    if (!snapshot.errors.some((message: string) => message.includes("net::ERR_NETWORK_CHANGED"))) throw error;
    console.warn("Executor network changed during startup; reloading once before testing the UI");
    await browser("navigate", url);
    await waitFor('document.querySelector("#loginDialog")?.open === true');
  }
}

async function choose(value: string) {
  await browser("evaluate", `(() => { const select = document.querySelector('${select}'); select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event("change", {bubbles:true})); return select.value; })()`);
}

async function openClassification(engine: string) {
  await browser("evaluate", `(async () => {
    const {state} = await import('/app/state.js');
    const session = state.sessions.find(session => session.harnessId === ${JSON.stringify(engine)} && !session.readOnly);
    window.classificationTarget = {id:session.id, path:session.path};
    session.running = true;
    (await import('/app/session-list.js')).renderSessions();
    document.querySelector('[data-session-path="' + CSS.escape(session.path) + '"] [data-testid="session-menu-button"]').click();
    return true;
  })()`);
  assert.equal(await browser("evaluate", 'Boolean(document.querySelector(\'[data-testid="session-classification-button"]\'))'), true, "existing conversation actions must offer Classification");
  assert.equal(await browser("evaluate", 'document.querySelector(\'[data-testid="session-fork-button"]\').disabled'), false, "running conversations must offer Fork conversation");
  await browser("click", '[data-testid="session-classification-button"]');
  await waitFor(`document.querySelector('${dialog}').open`);
}

async function assertSaved(label: string | null) {
  await browser("click", save);
  await waitFor(`!document.querySelector('${dialog}').open`);
  await waitFor(`(async () => {
    const {state} = await import('/app/state.js');
    const session = state.sessions.find(session => session.id === window.classificationTarget.id);
    return (session.classification || null) === ${JSON.stringify(label)};
  })()`);
  const badge = await browser("evaluate", `document.querySelector('[data-session-path="' + CSS.escape(window.classificationTarget.path) + '"] [data-testid="session-classification"]')?.textContent || null`);
  assert.equal(badge, label, "saved classification must appear in the conversation row");
}

async function editExisting(engine: string) {
  await openClassification(engine);
  assert.equal(await browser("evaluate", `document.querySelector('${select}').value`), "");
  await choose("Bug");
  await assertSaved("Bug");
  await openClassification(engine);
  assert.equal(await browser("evaluate", `document.querySelector('${select}').value`), "Bug", "reopening preselects current classification");
  await choose("Feature");
  await browser("click", cancel);
  await openClassification(engine);
  assert.equal(await browser("evaluate", `document.querySelector('${select}').value`), "Bug", "Cancel must not save");
  await choose("__other__");
  await browser("click", save);
  assert.equal(await browser("evaluate", `document.querySelector('${dialog}').open`), true, "Other requires text");
  await browser("fill", other, "Investigation <custom>");
  await browser("evaluate", `(() => {
    const nativeFetch = window.fetch;
    window.restoreClassificationFetch = () => { window.fetch = nativeFetch; };
    window.fetch = (url, options) => String(url).endsWith('/sessions/classification') ? Promise.resolve(Response.json({error:'Classification save unavailable'}, {status:503})) : nativeFetch(url, options);
    return true;
  })()`);
  await browser("click", save);
  await waitFor("document.body.innerText.includes('Classification save unavailable')");
  assert.equal(await browser("evaluate", `document.querySelector('${dialog}').open && !document.querySelector('${save}').disabled`), true, "failed save keeps dialog editable");
  await browser("evaluate", 'window.restoreClassificationFetch(); true');
  await assertSaved("Investigation <custom>");
  await browser("navigate", await browser("evaluate", "location.href"));
  await waitFor("document.querySelector('#sessionList [data-testid=\"session-menu-button\"]') !== null");
  await openClassification(engine);
  assert.equal(await browser("evaluate", `document.querySelector('${select}').value`), "__other__");
  assert.equal(await browser("evaluate", `document.querySelector('${other}').value`), "Investigation <custom>", "custom label survives reload");
  await choose("");
  await assertSaved(null);
}

test("existing conversations can change and clear classifications through their row menu", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "edit-classification-browser-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  try {
    await startBrowser(node.url);
    await browser("fill", '[data-testid="login-username-input"]', environment.username);
    await browser("fill", '[data-testid="login-password-input"]', environment.password);
    await browser("click", '[data-testid="login-submit-button"]');
    await waitFor("document.querySelector('#projectList .project-card') !== null");
    await browser("evaluate", `document.querySelectorAll('#projectList .project-card').forEach(button => { if(button.textContent.includes('Internal Assistant')) button.click(); }); true`);
    await waitFor("document.querySelector('#sessionList [data-testid=\"session-menu-button\"]') !== null");
    for (const engine of ["pi", "claude"]) await editExisting(engine);
    await browser("evaluate", `(async () => {
      const {state} = await import('/app/state.js');
      const session = state.sessions.find(session => session.harnessId === 'pi');
      session.readOnly = true;
      (await import('/app/session-list.js')).renderSessions();
      document.querySelector('[data-session-path="' + CSS.escape(session.path) + '"] [data-testid="session-menu-button"]').click();
      return true;
    })()`);
    assert.equal(await browser("evaluate", 'Boolean(document.querySelector(\'[data-testid="session-classification-button"]\'))'), false, "read-only conversations must not offer classification edits");
  } catch (error) {
    console.error(await browser("snapshot"));
    throw error;
  } finally {
    try { await browser("close"); }
    finally { await stopDevNode(server); await rm(root, { recursive: true, force: true }); }
  }
});

async function configureHarnessDefaults() {
  await browser("click", '[data-testid="settings-open-button"]');
  await browser("click", '[data-testid="settings-tab-engines"]');
  assert.deepEqual(await browser("evaluate", `['Pi', 'Claude'].map(harness => document.querySelector('#settings' + harness + 'DefaultThinking')?.value)`), ["medium", "medium"], "both harnesses need editable medium defaults");
  await browser("fill", '[data-testid="settings-pi-default-provider"]', "anthropic");
  await browser("fill", '[data-testid="settings-pi-default-model"]', "claude-sonnet-4-5");
  await browser("evaluate", 'document.querySelector("#settingsPiDefaultThinking").value = "low"');
  await browser("click", '[data-testid="harness-tab-claude"]');
  await browser("fill", '[data-testid="settings-claude-default-model"]', "sonnet");
  await browser("evaluate", 'document.querySelector("#settingsClaudeDefaultThinking").value = "high"');
  await browser("click", '[data-testid="settings-save-button"]');
  await waitFor('!document.querySelector("#settingsDialog").open');
  assert.deepEqual(await browser("evaluate", '(async () => (await (await fetch("/api/settings")).json()).conversationDefaults)()'), {
    pi: { provider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevel: "low" },
    claude: { provider: "claude", modelId: "sonnet", thinkingLevel: "high" },
  });
}

async function assertNewConversationDefaults(engine: string, model: string, thinking: string) {
  await browser("click", engine === "pi" ? '[data-testid="session-create-button"]' : '[data-testid="session-create-claude-button"]');
  await browser("fill", '[data-testid="new-session-name-input"]', `${engine} defaults check`);
  await browser("click", '[data-testid="new-session-name-start-button"]');
  await waitFor(`(async () => { const {state} = await import('/app/state.js'); return state.activeSessionId && state.engine === ${JSON.stringify(engine)} && state.thinkingLevel === ${JSON.stringify(thinking)}; })()`);
  const selectedModel = await browser("evaluate", '(async () => (await import("/app/state.js")).state.activeModelKey)()');
  assert.equal(selectedModel, model, "new conversation uses the configured model");
}

test("Settings edit per-harness model and thinking defaults for new conversations", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-defaults-browser-"));
  const environment = await seedDevEnvironment(root, 1);
  const server = await startDevNode(environment, environment.nodes[0]);
  try {
    await startBrowser(environment.nodes[0].url);
    await browser("fill", '[data-testid="login-username-input"]', environment.username);
    await browser("fill", '[data-testid="login-password-input"]', environment.password);
    await browser("click", '[data-testid="login-submit-button"]');
    await waitFor("document.querySelector('#projectList .project-card') !== null");
    await browser("evaluate", `document.querySelectorAll('#projectList .project-card').forEach(button => { if(button.textContent.includes('Internal Assistant')) button.click(); }); true`);
    await waitFor("document.querySelector('#sessionList [data-testid=\"session-menu-button\"]') !== null");
    await configureHarnessDefaults();
    await browser("navigate", environment.nodes[0].url);
    await waitFor("document.querySelector('#sessionList [data-testid=\"session-menu-button\"]') !== null");
    await browser("click", '[data-testid="settings-open-button"]');
    await waitFor('document.querySelector("#settingsDialog").open');
    assert.equal(await browser("evaluate", 'document.querySelector("#settingsPiDefaultThinking").value'), "low", "saved defaults survive reload");
    assert.equal(await browser("evaluate", 'document.querySelector("#settingsClaudeDefaultModel").value'), "sonnet");
    await browser("evaluate", 'document.querySelector("#settingsDialog").close(); true');
    await assertNewConversationDefaults("pi", "anthropic/claude-sonnet-4-5", "low");
    await assertNewConversationDefaults("claude", "claude/sonnet", "high");
  } catch (error) {
    console.error(await browser("snapshot"));
    throw error;
  } finally {
    try { await browser("close"); }
    finally { await stopDevNode(server); await rm(root, { recursive: true, force: true }); }
  }
});
