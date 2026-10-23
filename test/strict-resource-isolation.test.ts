import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentResourcePaths, claudeAgentResourceArgs, reconcileAgentResources } from "../src/agent-resources.js";
import { listHarnessCommands } from "../src/commands.js";
import { claudeResourceIsolationArgs } from "../src/harnesses/claude/resources.js";
import { settingsSchema } from "../src/server/schemas.js";
import { addProject } from "../src/store.js";
import { expandKiroPrompt, kiroAgentProfile } from "../src/harnesses/kiro/resources.js";
import { createPiSession } from "../src/pi-service.js";
import { getSettings, updateSettings } from "../src/settings.js";
import { createPiResourceLoader } from "../src/harnesses/pi/resource-loader.js";
import { listSkills } from "../src/skills.js";

const root = path.join(os.homedir(), "isolation");
const project = path.join(root, "project");
const resources = path.join(root, "managed");
const pi = path.join(os.homedir(), ".pi", "agent");
const kiro = path.join(os.homedir(), ".kiro");

async function write(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}
async function skill(directory: string, name: string): Promise<void> {
  await write(path.join(directory, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n`);
}
async function extension(file: string, name: string): Promise<void> {
  await write(file, `import { writeFileSync } from 'node:fs';\nexport default pi => { writeFileSync(${JSON.stringify(path.join(root, `${name}.ran`))}, 'ran'); pi.registerCommand('${name}', { description: '${name}', handler: async () => {} }); };`);
}

test.before(async () => {
  await mkdir(project, { recursive: true });
  assert.equal(getSettings().strictResourceIsolation, true);
  updateSettings({ syncthing: { endpoint: "" }, projects: { homePath: root } });
});
test.after(async () => { await rm(root, { recursive: true, force: true }); });

test("strict Pi catalogs never execute native extensions and retain arbitrary managed paths", async () => {
  await extension(path.join(pi, "extensions", "native.ts"), "native-extension");
  await extension(path.join(resources, "pi/extensions/managed.ts"), "managed-extension");
  await skill(path.join(pi, "skills"), "native-skill");
  await skill(path.join(os.homedir(), ".agents/skills"), "native-agents-skill");
  await skill(path.join(resources, "shared/skills"), "managed-skill");
  await skill(path.join(project, ".pi/skills"), "project-skill");
  await write(path.join(resources, "pi/prompts/managed-prompt.md"), "Managed prompt");
  const nativePackage = path.join(root, "native-package");
  await extension(path.join(nativePackage, "extensions/native.ts"), "native-package");
  await write(path.join(pi, "settings.json"), JSON.stringify({ packages: [nativePackage] }));
  const projectPackage = path.join(project, "project-package");
  await extension(path.join(projectPackage, "extensions/project.ts"), "project-package");
  await write(path.join(project, ".pi/settings.json"), JSON.stringify({ packages: [projectPackage] }));
  const commands = await listHarnessCommands(project, "pi", { piAgentDir: pi, resourceRoot: resources });
  assert.equal(commands.some((item) => item.name.startsWith("native-") || item.name.startsWith("skill:native-")), false);
  for (const name of ["managed-extension", "managed-prompt", "skill:managed-skill", "skill:project-skill"]) {
    assert.ok(commands.some((item) => item.name === name), `missing ${name}`);
  }
  // A project's own Pi packages run code; the app does not carry them over from `.pi/settings.json`.
  assert.equal(commands.some((item) => item.name === "project-package"), false);
  await assert.rejects(readFile(path.join(root, "native-extension.ran")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(root, "native-package.ran")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(root, "project-package.ran")), { code: "ENOENT" });
});

test("strict Pi sessions use the same isolation on open and reload", async () => {
  await write(path.join(pi, "AGENTS.md"), "NATIVE_INSTRUCTIONS");
  await write(path.join(project, "AGENTS.md"), "PROJECT_INSTRUCTIONS");
  await write(path.join(root, "AGENTS.md"), "PARENT_INSTRUCTIONS");
  await write(path.join(root, "CLAUDE.md"), "PARENT_CLAUDE");
  await write(path.join(pi, "SYSTEM.md"), "NATIVE_SYSTEM");
  await write(path.join(pi, "APPEND_SYSTEM.md"), "NATIVE_APPEND");
  await skill(agentResourcePaths().sharedSkills, "session-managed");
  const defaults = getSettings().conversationDefaults;
  updateSettings({ syncthing: { endpoint: "" }, conversationDefaults: { ...defaults, pi: { provider: "openai", modelId: "gpt-4o", thinkingLevel: "off" } } });
  const record = await addProject("Isolation fixture", project, { writeInstructions: false });
  const handle = await createPiSession({ cwd: project, projectId: record.id, conversationId: "isolation-session" });
  try {
    for (let pass = 0; pass < 2; pass += 1) {
      assert.doesNotMatch(handle.session.systemPrompt, /native-skill|native-agents-skill|NATIVE_INSTRUCTIONS|NATIVE_SYSTEM|NATIVE_APPEND|PARENT_INSTRUCTIONS|PARENT_CLAUDE/);
      assert.match(handle.session.systemPrompt, /session-managed/);
      assert.match(handle.session.systemPrompt, /PROJECT_INSTRUCTIONS/);
      await assert.rejects(readFile(path.join(root, "native-extension.ran")), { code: "ENOENT" });
      await handle.refreshResources!();
      await handle.session.reload();
    }
  } finally { handle.dispose(); }
});

test("Claude launch restricts settings and MCP sources even without a managed MCP file", async () => {
  await write(path.join(project, ".claude/settings.json"), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo project-hook" }] }] },
    env: { PROJECT_ENV: "1" },
    permissions: { deny: ["Read(./secrets/**)"] },
    enabledPlugins: { "native@market": true },
    apiKeyHelper: "/project/key.sh",
  }));
  const args = claudeResourceIsolationArgs(project, []);
  assert.equal(args[args.indexOf("--setting-sources") + 1], "");
  assert.ok(args.includes("--strict-mcp-config"));
  const settings = JSON.parse(await readFile(args[args.indexOf("--settings") + 1], "utf8"));
  assert.deepEqual(settings, {
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo project-hook" }] }] },
    env: { PROJECT_ENV: "1" },
    permissions: { deny: ["Read(./secrets/**)"] },
    enabledPlugins: { "agents-md@builtin": false, "cc-plugin-agents-md@builtin": false },
  }, "only the project's hooks, env and permissions are carried over");
  await rm(path.join(project, ".claude"), { recursive: true, force: true });
});

test("Kiro does not expand native prompts and keeps explicit project MCP", async () => {
  await write(path.join(kiro, "settings/mcp.json"), "invalid native config must never be read");
  await write(path.join(kiro, "prompts/private.md"), "NATIVE_PROMPT");
  assert.equal(await expandKiroPrompt("/private", project), "/private");
  await write(path.join(project, ".kiro/settings/mcp.json"), JSON.stringify({ mcpServers: { project: { command: "project-fixture" } } }));
  const name = await kiroAgentProfile({ cwd: project, sessionId: "isolation-test" }, "");
  const profile = JSON.parse(await readFile(path.join(kiro, "agents", `${name}.json`), "utf8"));
  assert.equal(profile.includeMcpJson, false);
  assert.deepEqual(profile.mcpServers, { project: { command: "project-fixture" } });
});

test("Claude preserves project MCP and managed commands, agents and instructions", async () => {
  const paths = agentResourcePaths(resources);
  await write(path.join(project, ".mcp.json"), '{"mcpServers":{}}');
  assert.equal(claudeResourceIsolationArgs(project, []).includes("--mcp-config"), false);
  await write(path.join(paths.claudeCommands, "managed.md"), "Managed command");
  await write(path.join(paths.claudeAgents, "reviewer.md"), "Managed agent");
  await write(path.join(paths.claudeCommands, "review/security.md"), "Nested command");
  await write(path.join(paths.claudeAgents, "review/security.md"), "Nested agent");
  await write(path.join(paths.claudeInstructions, "CLAUDE.md"), "Managed Claude instructions");
  const args = claudeAgentResourceArgs(resources);
  const plugin = args[args.indexOf("--plugin-dir") + 1];
  assert.equal(await readFile(path.join(plugin, "commands/managed.md"), "utf8"), "Managed command");
  assert.equal(await readFile(path.join(plugin, "agents/reviewer.md"), "utf8"), "Managed agent");
  assert.equal(await readFile(path.join(plugin, "commands/review/security.md"), "utf8"), "Nested command");
  assert.equal(await readFile(path.join(plugin, "agents/review/security.md"), "utf8"), "Nested agent");
  const commands = await listHarnessCommands(project, "claude", { resourceRoot: resources });
  assert.ok(commands.some((command) => command.invocation === "/joint-bob-resources:review:security "));
  assert.match(await readFile(args[args.indexOf("--append-system-prompt-file") + 1], "utf8"), /Managed Claude instructions/);
});

test("malformed managed Pi packages fail before native resource discovery", async () => {
  const file = path.join(resources, "pi/packages.json");
  await write(file, "invalid");
  assert.throws(() => createPiResourceLoader({ cwd: project, agentDir: pi }, true, file), SyntaxError);
  await write(file, '{"packages":false}');
  assert.throws(() => createPiResourceLoader({ cwd: project, agentDir: pi }, true, file), /must be an array/);
  await rm(file);
});

test("strict catalogs exclude native skills for every harness", async () => {
  const native = path.join(root, "native-skills");
  await skill(native, "unmanaged");
  const roots = { user: { pi: native, claude: native, kiro: native }, shared: agentResourcePaths(resources).sharedSkills };
  const skills = await listSkills(project, roots);
  assert.equal(skills.some((item) => item.name === "unmanaged"), false);
  for (const harness of ["pi", "claude", "kiro"]) assert.ok(skills.some((item) => item.harness === harness && item.name === "managed-skill"));
});

test("strict maintenance neither imports native resources nor rewrites native files", async () => {
  const native = path.join(pi, "prompts", "private.md");
  await write(native, "NATIVE_PROMPT");
  await reconcileAgentResources();
  assert.equal(await readFile(native, "utf8"), "NATIVE_PROMPT");
  await assert.rejects(readFile(path.join(agentResourcePaths().piPrompts, "private.md")), { code: "ENOENT" });
});

test("isolation setting validates API boundary values", () => {
  const input = { syncthing: { endpoint: "" }, strictResourceIsolation: false };
  assert.equal(settingsSchema.parse(input).strictResourceIsolation, false);
  assert.equal(updateSettings(input).strictResourceIsolation, false);
  assert.equal(updateSettings({ ...input, strictResourceIsolation: true }).strictResourceIsolation, true);
  assert.throws(() => updateSettings({ syncthing: { endpoint: "" }, strictResourceIsolation: "false" as never }), /boolean/i);
});
