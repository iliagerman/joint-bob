import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getHarnessRuntime } from "../src/harnesses.js";

// A fresh Claude chat used to report id "default" / label "Claude Code", so the
// toolbar named no model and the model dialog highlighted nothing.
test("a fresh Claude session defaults to a real, selectable model", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "bob-claude-default-"));
  const runtime = await getHarnessRuntime("claude");
  const session = await runtime.open({ cwd, projectId: "claude-default-project", sessionId: "00000000-0000-4000-8000-000000000001" });
  try {
    const settings = session.settings();
    assert.equal(settings.modelId, "claude-opus-5-5");
    assert.equal(settings.reasoning, "medium");

    const models = await runtime.models();
    assert.ok(models.some((model) => model.id === "claude-opus-5-5"), "Claude Opus 5.5 is missing from the runtime catalogue");
    const selected = models.find((model) => model.id === settings.modelId);
    assert.ok(selected, "Default Claude model is missing from the runtime catalogue");
    assert.ok(selected.label.trim());
    assert.notEqual(selected.label, "Claude Code");
    assert.notEqual(selected.id, "default");
    for (const model of models) {
      assert.ok(model.thinkingLevels.includes("default"), `${model.id} does not support default reasoning`);
      await runtime.validateSettings({ provider: model.provider, modelId: model.id, reasoning: "default" });
    }
  } finally {
    session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
