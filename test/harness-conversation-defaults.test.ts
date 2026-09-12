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
  updateSettings({ ...previous, pi: { ...previous.pi, configPath, sessionPath: path.join(root, "sessions") } });
  try {
    const { createPiSession } = await import("../src/pi-service.js");
    const first = await createPiSession({ cwd: root, projectId: project.id });
    try {
      assert.equal(first.session.model?.id, "gpt-5.6-sol");
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
  const { emptyClaudeState } = await import("../src/server/chat.js");
  const previous = getSettings();
  try {
    assert.equal(previous.conversationDefaults.claude.thinkingLevel, "medium");
    assert.equal(emptyClaudeState().effort, "medium");
    assert.equal(emptyClaudeState().model, "claude-opus-5");
    const conversationDefaults = { pi: { provider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevel: "low" }, claude: { provider: "claude", modelId: "sonnet", thinkingLevel: "high" } };
    updateSettings({ ...previous, conversationDefaults });
    assert.deepEqual(getSettings().conversationDefaults, conversationDefaults);
    assert.equal(emptyClaudeState().effort, "high");
    assert.equal(emptyClaudeState().model, "sonnet");
    assert.equal(emptyClaudeState("existing-session", false).effort, null, "legacy restored sessions keep their original implicit effort");
    assert.throws(() => updateSettings({ ...previous, conversationDefaults: { ...conversationDefaults, pi: { ...conversationDefaults.pi, thinkingLevel: "nonsense" } } }), /thinkingLevel/);
  } finally { updateSettings(previous); }
});
