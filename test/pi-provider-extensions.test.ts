import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import test from "node:test";
import { createCoreSession, type PiCoreHooks } from "../src/pi-session-core.js";

async function startProviderServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    request.resume();
    const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(chunk({ role: "assistant", content: "saved provider turn" }, null));
    response.write(chunk({}, "stop"));
    response.end("data: [DONE]\n\n");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const address = server.address() as { port: number };
    resolve({ server, url: `http://127.0.0.1:${address.port}/v1` });
  }));
}

test("Joint Bob model catalog loads a provider package installed in Pi", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-pi-provider-"));
  const agentDir = path.join(root, ".pi", "agent");
  const packageDir = path.join(root, "pi-provider-fixture");
  await mkdir(path.join(agentDir), { recursive: true });
  await mkdir(path.join(packageDir, "extensions"), { recursive: true });
  await writeFile(path.join(packageDir, "extensions", "provider.ts"), `export default pi => pi.registerProvider("fixture-provider", {
    api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "fixture-key",
    models: [{ id: "fixture-model", name: "Fixture Model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }]
  });`);
  const settings = await import("../src/settings.js");
  const previous = settings.getSettings();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  settings.updateSettings({ pi: { ...previous.pi, configPath: agentDir } });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const { listAvailableModels, modelIsRunnable, nodePiCredentialList } = await import("../src/pi-service.js");
    assert.equal((await listAvailableModels()).some((model) => model.provider === "fixture-provider"), false);
    assert.equal(await modelIsRunnable("fixture-provider", "fixture-model"), false);
    await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [packageDir] }));
    const available = await listAvailableModels();
    assert.ok(available.some((model) => model.provider === "fixture-provider" && model.id === "fixture-model"));
    assert.equal(await modelIsRunnable("fixture-provider", "fixture-model"), true);
    assert.deepEqual(await nodePiCredentialList(), []);
  } finally {
    settings.updateSettings({ pi: previous.pi });
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi session binds an installed provider before selecting its default model", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-pi-session-provider-"));
  const agentDir = path.join(root, ".pi", "agent");
  const cwd = path.join(root, "project");
  const packageDir = path.join(root, "pi-provider-fixture");
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(cwd, { recursive: true })]);
  await mkdir(path.join(packageDir, "extensions"), { recursive: true });
  const providerServer = await startProviderServer();
  try {
    await writeFile(path.join(packageDir, "extensions", "provider.ts"), `export default pi => pi.registerProvider("fixture-provider", {
    api: "openai-completions", baseUrl: ${JSON.stringify(providerServer.url)}, apiKey: "fixture-key",
    models: [{ id: "fixture-model", name: "Fixture Model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }]
  });`);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [packageDir] }));
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  const hooks: PiCoreHooks = {
    conversationId: async (sessionId) => sessionId,
    persistAccounts: async () => {},
    credentials: async () => ({ environment: {}, capabilityEnvironment: {}, credentialContext: "" }),
    resources: async () => ({
      strictResourceIsolation: true, packagesFile: "", extensions: [], prompts: [], themes: [], agentsFiles: [],
      skillRoots: [], managedSkillRoot: path.join(root, "managed-skills"), blockedSkillNames: [],
    }),
  };
    const sessionRoot = path.join(root, "sessions");
    const handle = await createCoreSession(modelRuntime, {
      cwd, agentDir, sessionRoot, sessionId: "provider-session",
      defaults: { provider: "fixture-provider", modelId: "fixture-model", thinkingLevel: "off" },
    }, hooks);
    let sessionPath: string | undefined;
    try {
      assert.equal(handle.session.model?.provider, "fixture-provider");
      assert.equal(handle.session.model?.id, "fixture-model");
      await handle.session.prompt("persist selected provider");
      sessionPath = handle.session.sessionFile;
    } finally { handle.dispose(); }
    assert.ok(sessionPath, "the provider selection is persisted in the session");
    assert.deepEqual(SessionManager.open(sessionPath, sessionRoot, cwd).buildSessionContext().model, {
      provider: "fixture-provider", modelId: "fixture-model",
    });
    const reopened = await createCoreSession(await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false }), {
      cwd, agentDir, sessionRoot, sessionPath,
      defaults: { provider: "fixture-provider", modelId: "ignored-default", thinkingLevel: "off" },
    }, hooks);
    try {
      assert.equal(reopened.session.model?.provider, "fixture-provider");
      assert.equal(reopened.session.model?.id, "fixture-model");
    } finally { reopened.dispose(); }
  } finally {
    await new Promise<void>((resolve) => providerServer.server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi session fails clearly when its installed provider has no Pi auth", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-pi-missing-auth-"));
  const agentDir = path.join(root, ".pi", "agent");
  const cwd = path.join(root, "project");
  const packageDir = path.join(root, "pi-provider-fixture");
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(cwd, { recursive: true }), mkdir(path.join(packageDir, "extensions"), { recursive: true })]);
  await writeFile(path.join(packageDir, "extensions", "provider.ts"), `export default pi => pi.registerProvider("fixture-provider", {
    api: "openai-completions", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "fixture-model", name: "Fixture Model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }]
  });`);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [packageDir] }));
  const hooks: PiCoreHooks = {
    conversationId: async (sessionId) => sessionId,
    persistAccounts: async () => {},
    credentials: async () => ({ environment: {}, capabilityEnvironment: {}, credentialContext: "" }),
    resources: async () => ({
      strictResourceIsolation: true, packagesFile: "", extensions: [], prompts: [], themes: [], agentsFiles: [],
      skillRoots: [], managedSkillRoot: path.join(root, "managed-skills"), blockedSkillNames: [],
    }),
  };
  try {
    await assert.rejects(createCoreSession(await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false }), {
      cwd, agentDir, sessionRoot: path.join(root, "sessions"), sessionId: "missing-auth-session",
      defaults: { provider: "fixture-provider", modelId: "fixture-model", thinkingLevel: "off" },
    }, hooks), /No API key for fixture-provider\/fixture-model/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Pi provider loading forces Cursor tool and settings policy while retaining the Pi bridge", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-pi-cursor-policy-"));
  const agentDir = path.join(root, ".pi", "agent");
  const cwd = path.join(root, "project");
  const packageDir = path.join(root, "pi-provider-fixture");
  const marker = path.join(root, "policy.json");
  const names = ["PI_CURSOR_NATIVE_TOOLS", "PI_CURSOR_SETTING_SOURCES", "PI_CURSOR_EXPOSE_BUILTIN_TOOLS", "PI_CURSOR_PI_TOOL_BRIDGE"];
  const previous = names.map((name) => process.env[name]);
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(cwd, { recursive: true })]);
  await mkdir(path.join(packageDir, "extensions"), { recursive: true });
  await writeFile(path.join(packageDir, "extensions", "policy.ts"), `import { writeFileSync } from "node:fs";
    export default () => writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
      nativeTools: process.env.PI_CURSOR_NATIVE_TOOLS,
      settingSources: process.env.PI_CURSOR_SETTING_SOURCES,
      exposeBuiltins: process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS,
      bridge: process.env.PI_CURSOR_PI_TOOL_BRIDGE
    }));`);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [packageDir] }));
  process.env.PI_CURSOR_NATIVE_TOOLS = "1";
  process.env.PI_CURSOR_SETTING_SOURCES = "all";
  process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "0";
  process.env.PI_CURSOR_PI_TOOL_BRIDGE = "0";
  try {
    const { listHarnessCommands } = await import("../src/commands.js");
    await listHarnessCommands(cwd, "pi", { piAgentDir: agentDir, resourceRoot: path.join(root, "resources") });
    assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), {
      nativeTools: "0", settingSources: "none", exposeBuiltins: "1", bridge: "1",
    });
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
    await rm(root, { recursive: true, force: true });
  }
});

test("remote Pi staging copies installed package dependencies but only writes extension settings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-pi-worker-provider-"));
  const sourceAgentDir = path.join(root, "service", ".pi", "agent");
  const targetAgentDir = path.join(root, "worker", ".pi", "agent");
  const cwd = path.join(root, "project");
  const packageRoot = path.join(sourceAgentDir, "npm", "node_modules", "fixture-provider");
  const dependencyRoot = path.join(sourceAgentDir, "npm", "node_modules", "fixture-dependency");
  await Promise.all([mkdir(path.join(packageRoot, "extensions"), { recursive: true }), mkdir(dependencyRoot, { recursive: true }), mkdir(cwd, { recursive: true })]);
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "fixture-provider", version: "1.0.0", dependencies: { "fixture-dependency": "1.0.0" } }));
  await writeFile(path.join(dependencyRoot, "package.json"), JSON.stringify({ name: "fixture-dependency", version: "1.0.0", main: "index.js" }));
  await writeFile(path.join(dependencyRoot, "index.js"), `exports.marker = "dependency-loaded";`);
  await writeFile(path.join(packageRoot, "extensions", "provider.ts"), `import { marker } from "fixture-dependency";
    export default pi => pi.registerCommand("staged-provider", { description: marker, handler: async () => {} });`);
  await writeFile(path.join(sourceAgentDir, "settings.json"), JSON.stringify({
    defaultProvider: "native-setting-must-not-copy", shellPath: "native-shell-must-not-copy",
    packages: [{ source: "npm:fixture-provider@1.0.0", skills: ["skills/**"], prompts: ["prompts/**"], themes: ["themes/**"] }],
  }));
  await writeFile(path.join(sourceAgentDir, "auth.json"), JSON.stringify({ marker: "auth-must-not-copy" }));
  try {
    const { stageInstalledPiPackages } = await import("../src/harnesses/pi/package-staging.js");
    await stageInstalledPiPackages(sourceAgentDir, targetAgentDir);
    assert.deepEqual(JSON.parse(await readFile(path.join(targetAgentDir, "settings.json"), "utf8")), {
      packages: [{ source: path.join(targetAgentDir, "npm", "node_modules", "fixture-provider"), skills: [], prompts: [], themes: [] }],
    });
    await assert.rejects(readFile(path.join(targetAgentDir, "auth.json")), { code: "ENOENT" });
    const { listHarnessCommands } = await import("../src/commands.js");
    const commands = await listHarnessCommands(cwd, "pi", { piAgentDir: targetAgentDir, resourceRoot: path.join(root, "resources") });
    assert.equal(commands.find((command) => command.name === "staged-provider")?.description, "dependency-loaded");
  } finally { await rm(root, { recursive: true, force: true }); }
});
