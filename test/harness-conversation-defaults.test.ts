import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getSettings, updateSettings } from "../src/settings.js";

test("new Pi sessions ignore last-used SDK model and thinking, and honor node overrides", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bob-defaults-"));
  const { addProject } = await import("../src/store.js");
  const project = await addProject("Defaults test", root);
  const previous = getSettings();
  const configPath = path.join(root, "agent");
  const previousApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-only-not-a-real-key";
  await mkdir(configPath);
  await writeFile(path.join(configPath, "settings.json"), JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-5", defaultThinkingLevel: "high" }));
  // The builtin pi catalog does not know gpt-6-sol yet; expose it like a custom store entry.
  await writeFile(path.join(configPath, "models.json"), JSON.stringify({
    providers: {
      "openai-codex": {
        models: [{
          id: "gpt-6-sol",
          name: "GPT-6 Sol",
          api: "openai-responses",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 272000,
          maxTokens: 128000,
        }],
      },
    },
  }));
  updateSettings({ ...previous, pi: { ...previous.pi, configPath, sessionPath: path.join(root, "sessions") } });
  try {
    const { createPiSession } = await import("../src/pi-service.js");
    const first = await createPiSession({ cwd: root, projectId: project.id });
    try {
      assert.equal(first.session.model?.id, "gpt-6-sol");
      assert.equal(first.session.thinkingLevel, "medium");
    } finally { first.dispose(); }
    updateSettings({ ...getSettings(), conversationDefaults: { pi: { provider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevel: "low" }, claude: { provider: "claude", modelId: "sonnet", thinkingLevel: "high" } } });
    const second = await createPiSession({ cwd: root, projectId: project.id });
    try {
      assert.equal(second.session.model?.id, "claude-sonnet-4-5");
      assert.equal(second.session.thinkingLevel, "low");
    } finally { second.dispose(); }
    const sessionPath = path.join(root, "restored.jsonl");
    const timestamp = new Date().toISOString();
    await writeFile(sessionPath, [
      { type: "session", version: 3, id: "restored", cwd: root, timestamp },
      { type: "model_change", id: "model", parentId: null, timestamp, provider: "anthropic", modelId: "claude-opus-4-5" },
      { type: "thinking_level_change", id: "thinking", parentId: "model", timestamp, thinkingLevel: "low" },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const restored = await createPiSession({ cwd: root, projectId: project.id, sessionPath });
    try {
      assert.equal(restored.session.model?.id, "claude-opus-4-5", "empty restore must not use last SDK model");
      assert.equal(restored.session.thinkingLevel, "low", "empty restore must not use last SDK thinking");
    } finally { restored.dispose(); }
  } finally {
    if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousApiKey;
    updateSettings(previous);
    await rm(root, { recursive: true, force: true });
  }
});

test("Settings persist per-harness defaults and reject invalid thinking", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bob-claude-defaults-"));
  const { getHarnessRuntime } = await import("../src/harnesses.js");
  const runtime = await getHarnessRuntime("claude");
  const previous = getSettings();
  try {
    assert.equal(previous.conversationDefaults.claude.thinkingLevel, "medium");
    const initial = await runtime.open({ cwd: root, projectId: "defaults-project", sessionId: "00000000-0000-4000-8000-000000000002" });
    try {
      assert.deepEqual(initial.settings(), { provider: "claude", modelId: "claude-opus-5-5", reasoning: "medium" });
    } finally { initial.dispose(); }

    const conversationDefaults = {
      pi: { provider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevel: "low" },
      claude: { provider: "claude", modelId: "sonnet", thinkingLevel: "high" },
      kiro: previous.conversationDefaults.kiro,
    };
    const sessionRoot = path.join(root, "claude-sessions");
    updateSettings({ ...previous, claude: { ...previous.claude, sessionPath: sessionRoot }, conversationDefaults });
    assert.deepEqual(getSettings().conversationDefaults, conversationDefaults);

    const configured = await runtime.open({ cwd: root, projectId: "defaults-project", sessionId: "00000000-0000-4000-8000-000000000003" });
    try {
      assert.deepEqual(configured.settings(), { provider: "claude", modelId: "sonnet", reasoning: "high" });
    } finally { configured.dispose(); }

    await mkdir(sessionRoot, { recursive: true });
    const sessionPath = path.join(sessionRoot, "existing-session.jsonl");
    await writeFile(sessionPath, `${JSON.stringify({ type: "user", cwd: root, message: { role: "user", content: "Existing session" } })}\n`);
    const restored = await runtime.open({ cwd: root, projectId: "defaults-project", sessionId: "existing-session", sessionPath: `claude:${sessionPath}` });
    try {
      assert.deepEqual(restored.settings(), { provider: "claude", modelId: "claude-opus-5-5", reasoning: "default" });
    } finally {
      restored.dispose();
      await rm(sessionPath, { force: true });
    }

    assert.throws(() => updateSettings({ ...previous, conversationDefaults: { ...conversationDefaults, pi: { ...conversationDefaults.pi, thinkingLevel: "nonsense" } } }), /thinkingLevel/);
  } finally {
    updateSettings(previous);
    await rm(root, { recursive: true, force: true });
  }
});
