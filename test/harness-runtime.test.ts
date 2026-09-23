import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildHandoffContext } from "../src/handoff-context.js";
import { listDiscoveredHarnesses } from "../src/harnesses/registry.js";
import { simplifyMessages } from "../src/pi-service.js";
import { getSettings, updateSettings } from "../src/settings.js";
import { addProject } from "../src/store.js";

function replaceSettings(overrides: {
  claudeDefault?: ReturnType<typeof getSettings>["conversationDefaults"]["claude"];
  claudeRuntime?: { executable: string; configPath: string; sessionPath: string };
}): void {
  const current = getSettings();
  updateSettings({
    runtimes: { ...current.runtimes, ...(overrides.claudeRuntime ? { claude: overrides.claudeRuntime } : {}) },
    syncthing: { endpoint: current.syncthing.endpoint },
    projects: current.projects,
    resources: current.resources,
    conversationLabels: current.conversationLabels,
    conversationHistoryDays: current.conversationHistoryDays,
    conversationDefaults: {
      ...current.conversationDefaults,
      ...(overrides.claudeDefault ? { claude: overrides.claudeDefault } : {}),
    },
  });
}

test("built-in harnesses expose lazy runtime sessions", async () => {
  const adapters = listDiscoveredHarnesses();
  assert.deepEqual(adapters.map(({ id }) => id), ["pi", "claude", "kiro"]);
  for (const adapter of adapters) {
    assert.equal(typeof adapter.runtime, "function");
    const runtime = await adapter.runtime!();
    for (const method of ["open", "models", "validateSettings", "readiness"] as const) assert.equal(typeof runtime[method], "function", `${adapter.id}.${method}`);
  }
});

test("Claude drafts stay unmaterialized and use configured defaults", async () => {
  const adapter = listDiscoveredHarnesses().find(({ id }) => id === "claude")!;
  const runtime = await adapter.runtime!();
  const session = await runtime.open({ projectId: "project", cwd: process.cwd(), sessionId: "draft_claude" });
  assert.equal(session.file, undefined);
  assert.deepEqual(session.settings(), {
    provider: "claude",
    modelId: "claude-opus-5",
    reasoning: "medium",
  });
  session.dispose();
});

test("restored Claude sessions retain native defaults and saved tools before discovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-restored-runtime-"));
  const previous = getSettings();
  try {
    const sessions = path.join(root, "sessions");
    const transcript = path.join(sessions, "existing", "legacy.jsonl");
    await mkdir(path.dirname(transcript), { recursive: true });
    await writeFile(transcript, [
      JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }),
    ].join("\n") + "\n");
    replaceSettings({
      claudeDefault: { provider: "claude", modelId: "sonnet", thinkingLevel: "high" },
      claudeRuntime: { ...previous.runtimes.claude, sessionPath: sessions },
    });
    const adapter = listDiscoveredHarnesses().find(({ id }) => id === "claude")!;
    const runtime = await adapter.runtime!();
    const session = await runtime.open({ projectId: "project", cwd: root, sessionId: "legacy", sessionPath: `claude:${transcript}` });
    assert.deepEqual(session.settings(), { provider: "claude", modelId: "claude-opus-5", reasoning: "default" });
    await session.configure({ provider: "claude", modelId: "claude-opus-5", reasoning: "default", enabledTools: ["Bash"] });
    assert.deepEqual(session.settings().enabledTools, ["Bash"]);
    assert.deepEqual(session.tools(), [{ name: "Bash", description: "Bash", active: true }]);
    session.dispose();
  } finally {
    replaceSettings({ claudeDefault: previous.conversationDefaults.claude, claudeRuntime: previous.runtimes.claude });
    await rm(root, { recursive: true, force: true });
  }
});

test("fresh Claude tool selection requires CLI discovery", async () => {
  const adapter = listDiscoveredHarnesses().find(({ id }) => id === "claude")!;
  const runtime = await adapter.runtime!();
  const session = await runtime.open({ projectId: "project", cwd: process.cwd(), sessionId: "fresh_tools" });
  await assert.rejects(session.setTools(["Bash"]), {
    message: "Claude has not reported its tools yet — send a message first",
  });
  await session.setTools([]);
  session.dispose();
});

test("Claude default reasoning suppresses configured effort on native spawn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-native-args-"));
  const previous = getSettings();
  const executable = path.join(root, "fake-claude.mjs");
  const argsFile = path.join(root, "args.json");
  try {
    await writeFile(executable, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\nconsole.log(JSON.stringify({type:"system",subtype:"init",session_id:"native_default",tools:["Bash"]}));\nconsole.log(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"ok"}],usage:{input_tokens:7,cache_creation_input_tokens:0,cache_read_input_tokens:0}}}));\nconsole.log(JSON.stringify({type:"result",is_error:false}));\n`);
    await chmod(executable, 0o755);
    const configPath = path.join(root, "config");
    const sessionPath = path.join(root, "sessions");
    await mkdir(configPath, { recursive: true });
    await mkdir(sessionPath, { recursive: true });
    replaceSettings({
      claudeDefault: { provider: "claude", modelId: "sonnet", thinkingLevel: "high" },
      claudeRuntime: { executable, configPath, sessionPath },
    });
    const project = await addProject("Claude fixture", root, { writeInstructions: false });
    const adapter = listDiscoveredHarnesses().find(({ id }) => id === "claude")!;
    const runtime = await adapter.runtime!();
    const session = await runtime.open({ projectId: project.id, cwd: root, sessionId: "native_default" });
    await session.configure({ provider: "claude", modelId: "sonnet", reasoning: "default" });
    const prompt = `${buildHandoffContext([{ id: "old", role: "user", text: "prior history" }])}actual question`;
    await session.prompt({ text: prompt });
    const args = JSON.parse(await readFile(argsFile, "utf8")) as string[];
    assert.equal(args.includes("--effort"), false, args.join(" "));
    assert.equal(session.messages.find((message) => message.role === "user")?.text, "actual question");
    session.dispose();
  } finally {
    replaceSettings({ claudeDefault: previous.conversationDefaults.claude, claudeRuntime: previous.runtimes.claude });
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi display messages keep timestamps and strip handoff context only from user messages", () => {
  const prompt = `${buildHandoffContext([{ id: "old", role: "user", text: "prior history" }])}actual question`;
  assert.deepEqual(simplifyMessages([
    { role: "user", content: prompt, timestamp: Date.parse("2026-01-01T00:00:00.000Z") },
    { role: "assistant", content: prompt, timestamp: "2026-01-01T00:01:00.000Z" },
  ]).map(({ role, text, timestamp }) => ({ role, text, timestamp })), [
    { role: "user", text: "actual question", timestamp: "2026-01-01T00:00:00.000Z" },
    { role: "assistant", text: prompt, timestamp: "2026-01-01T00:01:00.000Z" },
  ]);
});

test("Kiro persisted configuration and rename survive reopen", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kiro-runtime-"));
  process.env.JOINT_BOB_TEST_KIRO_SESSION_ROOT = path.join(root, "sessions");
  const storage = await import("../src/harnesses/kiro/storage.js");
  const file = await storage.initializeKiroSession(
    { projectId: "project", cwd: root, sessionId: "persisted" },
    { provider: "kiro", modelId: "default", reasoning: "medium" },
  );
  const adapter = listDiscoveredHarnesses().find(({ id }) => id === "kiro")!;
  const runtime = await adapter.runtime!();
  const session = await runtime.open({ projectId: "project", cwd: root, sessionId: "persisted", sessionPath: `kiro:${file}` });
  await session.configure({ provider: "kiro", modelId: "custom", reasoning: "high" });
  await session.rename("Persisted title");
  session.dispose();
  await storage.appendKiroRecord(file, { type: "message", role: "assistant", text: "Attributed answer", timestamp: "2026-09-22T08:00:00.000Z" });
  const reopened = await runtime.open({ projectId: "project", cwd: root, sessionId: "persisted", sessionPath: `kiro:${file}` });
  assert.deepEqual(reopened.settings(), { provider: "kiro", modelId: "custom", reasoning: "high" });
  assert.equal(reopened.status().sessionName, "Persisted title");
  assert.deepEqual(reopened.messages.at(-1)?.attribution, { harnessId: "kiro", provider: "kiro", modelId: "custom", reasoning: "high" });
  reopened.dispose();
});

test("Kiro drafts are local and use the default model sentinel", async () => {
  const adapter = listDiscoveredHarnesses().find(({ id }) => id === "kiro")!;
  const runtime = await adapter.runtime!();
  const session = await runtime.open({ projectId: "project", cwd: process.cwd(), sessionId: "draft_test" });
  assert.equal(session.id, "draft_test");
  assert.equal(session.file, undefined);
  assert.equal(session.settings().modelId, "default");
  assert.equal(session.status().isStreaming, false);
  await assert.rejects(runtime.validateSettings({ provider: "other", modelId: "default", reasoning: "medium" }), /Provider must be kiro/);
  session.dispose();
});
