import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getHarnessRuntime, listHarnessModels } from "../src/harnesses.js";
import { claudeModelLabel, claudeModelsFromCatalogue } from "../src/harnesses/claude/models.js";
import { getSettings, updateSettings } from "../src/settings.js";

const catalogue = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
  { value: "fable", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1", supportsEffort: true, supportedEffortLevels: ["max"] },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" },
  { value: "claude-opus-4-8", resolvedModel: "claude-opus-4-8", displayName: "Opus 4.8", supportsEffort: true, supportedEffortLevels: ["medium"] },
];

/** Points the Claude runtime at a fixture CLI that answers the `initialize` handshake with `models`, or fails when null. */
async function useClaudeFixture(root: string, models: unknown[] | null): Promise<void> {
  const executable = path.join(root, `claude-fixture-${models ? "ok" : "broken"}.mjs`);
  const reply = JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "models", response: { models } } });
  await writeFile(executable, models
    ? `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on("end",()=>{console.log(${JSON.stringify(reply)});});\n`
    : `#!${process.execPath}\nprocess.exit(3);\n`);
  await chmod(executable, 0o700);
  const configPath = path.join(root, "config");
  await mkdir(configPath, { recursive: true });
  const previous = getSettings();
  const claude = { executable, configPath, sessionPath: path.join(root, "sessions") };
  updateSettings({ ...previous, runtimes: { ...previous.runtimes, claude }, claude });
}

// A fresh Claude chat used to report id "default" / label "Claude Code", so the
// toolbar named no model and the model dialog highlighted nothing.
test("a fresh Claude session defaults to a real, selectable model from the CLI catalogue", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "bob-claude-default-"));
  await useClaudeFixture(cwd, catalogue);
  const runtime = await getHarnessRuntime("claude");
  const session = await runtime.open({ cwd, projectId: "claude-default-project", sessionId: "00000000-0000-4000-8000-000000000001" });
  try {
    const settings = session.settings();
    assert.equal(settings.modelId, "opus");
    assert.equal(settings.reasoning, "medium");

    const models = await listHarnessModels("claude");
    assert.ok(models.some((model) => model.id === "claude-opus-4-8"), "a model reported only by the CLI is missing");
    const selected = models.find((model) => model.id === settings.modelId);
    assert.ok(selected, "Default Claude model is missing from the runtime catalogue");
    assert.equal(selected.label, "Opus 5.5");
    assert.equal(session.status().model?.label, "Opus 5.5");
    assert.equal(claudeModelLabel("claude-opus-5-5"), "Opus 5.5", "a saved pinned ID shows the CLI name of the alias it matches");
    assert.equal(claudeModelLabel("claude-unlisted-9"), "claude-unlisted-9");
    for (const model of models) {
      assert.ok(model.thinkingLevels.includes("default"), `${model.id} does not support default reasoning`);
      await runtime.validateSettings({ provider: model.provider, modelId: model.id, reasoning: "default" });
    }
    await assert.rejects(runtime.validateSettings({ provider: "claude", modelId: "not a model; rm -rf", reasoning: "default" }), /Unsupported Claude model/);

    await useClaudeFixture(cwd, null);
    const fallback = await listHarnessModels("claude");
    assert.ok(fallback.some((model) => model.id === "opus"), "fallback catalogue lacks the default model");
  } finally {
    session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the Claude catalogue mirrors the CLI picker: same entries, order, and names", () => {
  const models = claudeModelsFromCatalogue(catalogue);
  assert.deepEqual(models.map((model) => [model.id, model.label]), [
    ["default", "Default (recommended)"],
    ["opus", "Opus 5.5"],
    ["fable", "Fable 5.1"],
    ["haiku", "Haiku 4.5"],
    ["claude-opus-4-8", "Opus 4.8"],
  ]);
  assert.deepEqual(models.find((model) => model.id === "haiku")?.thinkingLevels, ["default"]);
  assert.deepEqual(models.find((model) => model.id === "fable")?.thinkingLevels, ["default", "max"]);
  assert.throws(() => claudeModelsFromCatalogue([]), /no models/);
});
