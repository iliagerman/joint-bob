import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";

let root: string;
let server: ChildProcess;
let browser: Browser;
let page: Page;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-queued-editor-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  server = await startDevNode(environment, node);
  const session = await signIn(environment, node);
  browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  const [name, value] = session.cookie.split("=");
  await context.addCookies([{ name, value, url: node.url }]);
  page = await context.newPage();
  await page.goto(node.url);
  await page.getByText("Internal Assistant", { exact: true }).waitFor();
  await page.waitForFunction(async () => (await import("/app/state.js")).state.harnesses.some((harness) => harness.id === "kiro"));
});

after(async () => {
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

async function openEditor(): Promise<void> {
  await page.evaluate(`(async () => {
    const transcript = await import("/app/chat-transcript.js");
    const { state } = await import("/app/state.js");
    transcript.clearChat();
    // Capture the transport boundary. Cancel must never reach the server.
    window.queueCommands = [];
    state.socket = { readyState: WebSocket.OPEN, send: (raw) => window.queueCommands.push(JSON.parse(raw)) };
    state.engine = "pi";
    state.models = [
      { harnessId: "pi", provider: "openai-codex", id: "test-gpt", label: "Test GPT", thinkingLevels: ["off", "high"] },
      { harnessId: "pi", provider: "zai", id: "test-glm", label: "Test GLM", thinkingLevels: ["off", "high"] },
      { harnessId: "claude", provider: "claude", id: "haiku", label: "Haiku", thinkingLevels: ["default", "low", "medium", "high", "xhigh", "max"] },
    ];
    document.querySelector("#chatPanel").style.display = "flex";
    transcript.markMessageQueued(transcript.appendMessage("user", "Original\\n\\nAttached: notes.txt"), 71, "Original");
  })()`);
  await page.getByTestId("queued-message-edit-button").click();
}

async function commands(): Promise<unknown[]> {
  return page.evaluate(() => window.queueCommands);
}

async function openQueue(): Promise<void> {
  await openEditor();
  await page.getByTestId("queued-message-edit-cancel-button").click();
  await page.evaluate(async () => {
    const transcript = await import("/app/chat-transcript.js");
    transcript.markMessageQueued(transcript.appendMessage("user", "Second"), 72, "Second", null, 2);
    transcript.markMessageQueued(transcript.appendMessage("user", "Third"), 73, "Third", null, 3);
  });
}

test("queued editor labels Save and Cancel and shows shortcut hints", async () => {
  await openEditor();
  assert.match(await page.getByTestId("queued-message-save-button").innerText(), /^Save/);
  assert.match(await page.getByTestId("queued-message-edit-cancel-button").innerText(), /^Cancel/);
  assert.match(await page.locator(".queued-editor").innerText(), /Cmd\/Ctrl\+Enter/);
  assert.match(await page.locator(".queued-editor").innerText(), /Escape/);
});

test("queued messages can swap positions and merge any selection", async () => {
  await openQueue();
  const queuedText = () => page.locator(".message.user.queued").evaluateAll((messages) => messages.map((message) => message._raw));
  assert.deepEqual(await queuedText(), ["Original\n\nAttached: notes.txt", "Second", "Third"]);

  await page.getByTestId("queued-message-move-later-button").first().click();
  assert.deepEqual(await commands(), [{ type: "swapQueuedPrompts", queueItems: [{ id: "71", revision: 1 }, { id: "72", revision: 2 }] }]);
  await page.evaluate(async () => (await import("/app/chat-transcript.js")).syncQueuedMessageOrder(["72", "71", "73"]));
  assert.deepEqual(await queuedText(), ["Second", "Original\n\nAttached: notes.txt", "Third"]);

  const queued = page.locator(".message.user.queued");
  await queued.nth(0).getByTestId("queued-message-merge-checkbox").check();
  await queued.nth(2).getByTestId("queued-message-merge-checkbox").check();
  await page.getByTestId("queued-message-merge-button").click();
  assert.deepEqual((await commands()).at(-1), { type: "mergeQueuedPrompts", queueItems: [{ id: "72", revision: 2 }, { id: "73", revision: 3 }] });
});

test("queued messages stay below replies until they become active", async () => {
  await openEditor();
  await page.evaluate(async () => (await import("/app/chat-transcript.js")).appendMessage("assistant", "Current reply"));
  assert.deepEqual(await page.locator(".message").evaluateAll((messages) => messages.map((message) => message._raw)), ["Current reply", "Original\n\nAttached: notes.txt"]);

  await page.evaluate(async () => {
    const transcript = await import("/app/chat-transcript.js");
    transcript.clearQueuedMark(71);
    transcript.appendMessage("assistant", "Queued reply");
  });
  assert.deepEqual(await page.locator(".message").evaluateAll((messages) => messages.map((message) => message._raw)), ["Current reply", "Original\n\nAttached: notes.txt", "Queued reply"]);
});

test("Cancel and Escape discard drafts locally and restore saved text on reopen", async () => {
  for (const action of ["click", "Escape"]) {
    await openEditor();
    const input = page.getByTestId("queued-message-edit-input");
    await input.fill("Discard this");
    if (action === "click") await page.getByTestId("queued-message-edit-cancel-button").click();
    else await input.press("Escape");
    assert.equal(await input.isVisible(), false, `${action} closes the editor`);
    assert.deepEqual(await commands(), [], `${action} sends neither edit nor queue cancellation`);
    assert.equal(await page.getByTestId("queued-message-edit-button").evaluate((button) => button === document.activeElement), true);
    await page.getByTestId("queued-message-edit-button").click();
    assert.equal(await input.inputValue(), "Original");
    assert.match(await page.locator(".message.user .message-content").innerText(), /Attached: notes.txt/);
  }
});

test("queued model and effort are local drafts until Save, and Cancel restores inherit", async () => {
  await openEditor();
  const model = page.getByTestId("queued-message-model-button");
  await model.click();
  await page.getByTestId("queued-message-harness-select").selectOption("claude");
  await page.getByTestId("model-option-claude-haiku").click();
  await page.getByTestId("queued-message-reasoning-select").selectOption("high");
  assert.deepEqual(await commands(), []);
  await page.getByTestId("queued-message-edit-cancel-button").click();
  await page.getByTestId("queued-message-edit-button").click();
  assert.equal(await model.innerText(), "Inherit conversation settings");
  assert.equal(await page.getByTestId("queued-message-reasoning-select").isVisible(), false);
  await model.click();
  await page.getByTestId("queued-message-harness-select").selectOption("claude");
  await page.getByTestId("model-option-claude-haiku").click();
  await page.getByTestId("queued-message-reasoning-select").selectOption("high");
  await page.getByTestId("queued-message-save-button").click();
  assert.deepEqual(await commands(), [{ type: "editQueuedPrompt", queueId: 71, message: "Original", queueSettings: { harnessId: "claude", provider: "claude", modelId: "haiku", reasoning: "high" }, queueRevision: 1 }]);
});

test("queued harness picker filters available models and saves a Pi choice without changing the conversation", async () => {
  await openEditor();
  await page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    state.engine = "claude";
    state.activeModelKey = "claude/sonnet";
  });
  await page.getByTestId("queued-message-model-button").click();
  const harness = page.getByTestId("queued-message-harness-select");
  assert.equal(await harness.inputValue(), "claude");
  assert.equal(await page.getByTestId("model-option-openai-codex-test-gpt").count(), 0);
  await harness.selectOption("pi");
  assert.equal(await page.getByTestId("model-option-claude-haiku").count(), 0);
  assert.equal(await page.getByTestId("model-option-zai-test-glm").isVisible(), true);
  await page.getByTestId("model-option-openai-codex-test-gpt").click();
  await page.getByTestId("queued-message-reasoning-select").selectOption("high");
  await page.getByTestId("queued-message-model-button").click();
  assert.equal(await harness.inputValue(), "pi", "reopen follows the queued choice, not the live harness");
  await page.locator("#modelDialog").press("Escape");
  assert.deepEqual(await commands(), []);
  await page.getByTestId("queued-message-save-button").click();
  assert.deepEqual(await commands(), [{ type: "editQueuedPrompt", queueId: 71, message: "Original", queueSettings: { harnessId: "pi", provider: "openai-codex", modelId: "test-gpt", reasoning: "high" }, queueRevision: 1 }]);
  assert.deepEqual(await page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    return [state.engine, state.activeModelKey];
  }), ["claude", "claude/sonnet"]);
});

test("an unavailable saved model can be replaced with inheritance", async () => {
  await openEditor();
  await page.evaluate(async () => (await import("/app/chat-transcript.js")).updateQueuedMessage(71, "Original", "Original", { provider: "zai", modelId: "missing-on-this-node", reasoning: "high" }, 2));
  await page.getByTestId("queued-message-edit-button").click();
  assert.equal(await page.getByTestId("queued-message-edit-input").isVisible(), true);
  assert.match(await page.getByTestId("queued-message-model-button").innerText(), /unavailable/);
  await page.getByTestId("queued-message-model-button").click();
  await page.locator("#modelDialog").getByRole("button", { name: /Inherit conversation settings/ }).click();
  await page.getByTestId("queued-message-save-button").click();
  assert.deepEqual(await commands(), [{ type: "editQueuedPrompt", queueId: 71, message: "Original", queueSettings: null, queueRevision: 2 }]);
});

test("Save, Cmd+Enter and Ctrl+Enter each submit one edit; Enter stays multiline", async () => {
  for (const action of ["click", "Meta+Enter", "Control+Enter"]) {
    await openEditor();
    const input = page.getByTestId("queued-message-edit-input");
    await input.fill("Changed");
    await input.press("Enter");
    assert.equal(await input.inputValue(), "Changed\n");
    assert.deepEqual(await commands(), []);
    if (action === "click") await page.getByTestId("queued-message-save-button").click();
    else await input.press(action);
    assert.deepEqual(await commands(), [{ type: "editQueuedPrompt", queueId: 71, message: "Changed", queueSettings: null, queueRevision: 1 }]);
    assert.equal(await input.isVisible(), true, "keep draft until server acknowledges Save");
    await page.evaluate(async () => (await import("/app/chat-transcript.js")).updateQueuedMessage(71, "Changed\n\nAttached: notes.txt", "Changed"));
    assert.equal(await input.isVisible(), false);
    await page.getByTestId("queued-message-edit-button").click();
    assert.equal(await input.inputValue(), "Changed");
  }
});
