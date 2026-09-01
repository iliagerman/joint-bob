import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { claudeContextUsage } from "../src/claude-service.js";
import { getSessionStatus } from "../src/pi-service.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

const assistant = (model: string, usage: Record<string, number>): Record<string, unknown> => ({
  type: "assistant",
  message: { role: "assistant", model, usage },
});

test("Claude context usage sums the newest turn's input, cache and output tokens", () => {
  const usage = claudeContextUsage([
    assistant("claude-opus-5", { input_tokens: 5, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 5 }),
    { type: "user", message: { role: "user", content: "next" } },
    assistant("claude-opus-5", { input_tokens: 2, cache_creation_input_tokens: 3311, cache_read_input_tokens: 105707, output_tokens: 285 }),
  ]);

  assert.deepEqual(usage, { usedTokens: 109305, contextWindow: 200_000, percent: 55 });
});

test("Claude's 1M-context model variant reports the larger window", () => {
  const usage = claudeContextUsage([
    assistant("claude-opus-5[1m]", { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 250_000, output_tokens: 0 }),
  ]);

  assert.deepEqual(usage, { usedTokens: 250_000, contextWindow: 1_000_000, percent: 25 });
});

test("a Claude transcript with no reported usage has no context reading", () => {
  assert.equal(claudeContextUsage([{ type: "user", message: { role: "user", content: "hello" } }]), undefined);
});

const piSession = (contextUsage: unknown): AgentSession => ({
  sessionFile: "/tmp/session.jsonl",
  sessionId: "session",
  sessionName: "Session",
  model: undefined,
  thinkingLevel: "medium",
  getAvailableThinkingLevels: () => ["medium"],
  isStreaming: false,
  isCompacting: false,
  isRetrying: false,
  isBashRunning: false,
  pendingMessageCount: 0,
  messages: [],
  getActiveToolNames: () => [],
  promptTemplates: [],
  getContextUsage: () => contextUsage,
} as unknown as AgentSession);

test("Pi status carries the session's context usage", () => {
  const status = getSessionStatus(piSession({ tokens: 187_234, contextWindow: 400_000, percent: 46.8 }), true);

  assert.deepEqual(status.contextUsage, { usedTokens: 187_234, contextWindow: 400_000, percent: 47 });
});

test("Pi status omits context usage while the session cannot measure it", () => {
  assert.equal(getSessionStatus(piSession({ tokens: null, contextWindow: 400_000, percent: null }), true).contextUsage, undefined);
  assert.equal(getSessionStatus(piSession(undefined), true).contextUsage, undefined);
});

test("the chat header shows one context gauge for every harness", async () => {
  const [html, app, styles, worker] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
    readFile("public/sw.js", "utf8"),
  ]);
  const actionsStart = html.indexOf('<div class="chat-actions">');
  const actionsEnd = html.indexOf('id="abortButton"', actionsStart);
  assert.ok(actionsStart >= 0 && actionsEnd >= 0, "Missing chat actions");
  const actions = html.slice(actionsStart, actionsEnd);

  assert.match(actions, /id="contextUsage"[^>]*data-testid="chat-context-usage"[^>]*hidden/);
  assert.match(actions, /id="contextUsageFill"/);
  assert.match(actions, /id="contextUsageText"/);

  assert.match(app, /contextUsage: document\.querySelector\("#contextUsage"\)/);
  assert.match(app, /function syncContextUsage\(usage\)/);
  assert.match(app, /syncContextUsage\(status\.contextUsage\)/);
  assert.match(styles, /\.context-usage \{/);
  assert.match(worker, /const CACHE_NAME = "joint-bob-v86";/);
});
