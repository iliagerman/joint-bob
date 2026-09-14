import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { conversationDefaultsSchema } from "../src/harnesses/defaults.js";
import { listDiscoveredHarnesses } from "../src/harnesses/registry.js";
import { getRuntimeDefaults, getSettings, updateSettings } from "../src/settings.js";
import { resolveLocalSessionPath } from "../src/session-paths.js";
import { runtimeCheckSchema, settingsSchema } from "../src/server/schemas.js";

const adapters = listDiscoveredHarnesses();
const pi = adapters.find((adapter) => adapter.id === "pi")!;
const claude = adapters.find((adapter) => adapter.id === "claude")!;

test("installed adapters declare runtime configuration used by settings", () => {
  assert.ok(pi.configuration);
  assert.ok(claude.configuration);
  const defaults = getRuntimeDefaults();
  assert.deepEqual(defaults.pi, pi.configuration.defaults(os.homedir()));
  assert.deepEqual(defaults.claude, claude.configuration.defaults(os.homedir()));
  const settings = getSettings();
  assert.deepEqual(settings.runtimes.pi, settings.pi);
  assert.deepEqual(settings.runtimes.claude, settings.claude);
});

test("adapter thinking levels specialize conversation defaults", () => {
  const base = { provider: "openai-codex", modelId: "model", thinkingLevel: "off" };
  assert.equal(conversationDefaultsSchema.safeParse({ pi: base, claude: { ...base, provider: "claude" } }).success, false);
  assert.equal(conversationDefaultsSchema.safeParse({ pi: base, claude: { ...base, provider: "claude", thinkingLevel: "low" } }).success, true);
});

test("adapter transcript localization rehomes synchronized paths and rejects traversal", () => {
  const home = path.join(path.sep, "local", "home");
  assert.deepEqual(resolveLocalSessionPath("/Users/a/.pi/agent/sessions/x.jsonl", home), { engine: "pi", path: path.join(home, ".pi/agent/sessions/x.jsonl") });
  assert.deepEqual(resolveLocalSessionPath("claude:/home/a/.claude/projects/p/x.jsonl", home), { engine: "claude", path: `claude:${path.join(home, ".claude/projects/p/x.jsonl")}` });
  assert.throws(() => resolveLocalSessionPath("/home/a/.pi/../x.jsonl", home), /invalid session segment/);
  assert.throws(() => resolveLocalSessionPath("claude:\\home\\a\\.claude\\..\\x.jsonl", home), /invalid session segment/);
});

function restoreRuntimeSettings(previous: ReturnType<typeof getSettings>): void {
  updateSettings({
    runtimes: previous.runtimeOverrides,
    syncthing: { endpoint: previous.syncthing.endpoint },
  });
}

function changedClaudeRuntime(suffix: string): ReturnType<typeof getSettings>["claude"] {
  const root = path.join(os.homedir(), `.joint-bob-test-${suffix}`);
  return {
    executable: path.join(root, "claude"),
    configPath: path.join(root, "config"),
    sessionPath: path.join(root, "sessions"),
  };
}

test("round-trip settings accepts a changed legacy runtime alias", () => {
  const previous = getSettings();
  const changed = changedClaudeRuntime("legacy");
  try {
    const updated = updateSettings({ ...previous, claude: changed });
    assert.deepEqual(updated.claude, changed);
  } finally {
    restoreRuntimeSettings(previous);
  }
});

test("changed canonical runtime beats an unchanged legacy alias", () => {
  const previous = getSettings();
  const changed = changedClaudeRuntime("canonical");
  try {
    const updated = updateSettings({
      ...previous,
      runtimes: { ...previous.runtimes, claude: changed },
    });
    assert.deepEqual(updated.claude, changed);
  } finally {
    restoreRuntimeSettings(previous);
  }
});

test("conflicting runtime changes reject without persistence", () => {
  const previous = getSettings();
  try {
    assert.throws(() => updateSettings({
      ...previous,
      claude: changedClaudeRuntime("legacy-conflict"),
      runtimes: { ...previous.runtimes, claude: changedClaudeRuntime("canonical-conflict") },
    }), /Conflicting runtime settings for claude/);
    assert.deepEqual(getSettings().runtimeOverrides, previous.runtimeOverrides);
  } finally {
    restoreRuntimeSettings(previous);
  }
});

test("omitted runtimes preserve stored overrides instead of resolved defaults", () => {
  const previous = getSettings();
  const overrides = { ...previous.runtimeOverrides, claude: { executable: "", configPath: "", sessionPath: "" } };
  try {
    updateSettings({ runtimes: overrides, syncthing: { endpoint: previous.syncthing.endpoint } });
    const updated = updateSettings({ syncthing: { endpoint: previous.syncthing.endpoint } });
    assert.deepEqual(updated.runtimeOverrides.claude, overrides.claude);
  } finally {
    restoreRuntimeSettings(previous);
  }
});

test("dynamic runtime schemas retain legacy input and explicit runtime updates", () => {
  const current = getSettings();
  const legacy = { pi: current.pi, claude: current.claude };
  assert.equal(runtimeCheckSchema.safeParse(legacy).success, true);
  assert.equal(settingsSchema.safeParse({ ...current, syncthing: { endpoint: "" } }).success, true);
  const updated = updateSettings({
    pi: current.pi,
    claude: current.claude,
    runtimes: legacy,
    syncthing: { endpoint: current.syncthing.endpoint },
  });
  assert.deepEqual(updated.pi, current.pi);
  assert.deepEqual(updated.claude, current.claude);
  assert.deepEqual(updated.runtimes.kiro, current.runtimes.kiro);
  assert.deepEqual(updated.runtimeOverrides.kiro, current.runtimeOverrides.kiro);
});
