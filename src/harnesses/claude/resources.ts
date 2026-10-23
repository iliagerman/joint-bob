import fs from "node:fs";
import childProcess from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import { parse as parseYaml } from "yaml";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { builtinCommands, type CommandDiscoveryOptions, type HarnessCommand } from "../../commands.js";
import { defaultSkillRoots, parseResourceFrontmatter, readConfiguredSkillPath, readSkillDirectory, type SkillRoots, type SkillSummary } from "../../skills.js";
import { getSettings } from "../../settings.js";
import { resolveDataDirectory } from "../../data-directory.js";
import { agentResourcePaths, managedMarkdownFiles } from "../../agent-resources.js";
import { activeMcpServers, assertNoBlockedNativeResources } from "../../resource-activation.js";
import { projectFolderResources } from "../../project-folder-resources.js";
import type { HarnessResources } from "../resource-contract.js";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function json(file: string): Record<string, unknown> {
  try { return object(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch (error) { if (missing(error)) return {}; throw error; }
}

function untrackedLocalSettings(cwd: string): boolean {
  // Match the pinned CLI's fail-closed gate: tracked, symlinked and indeterminate
  // local settings are repository input, not proof of user approval.
  for (const file of [path.join(cwd, ".claude"), path.join(cwd, ".claude/settings.local.json")]) {
    try { if (fs.lstatSync(file).isSymbolicLink()) return false; }
    catch (error) { if (missing(error)) return false; throw error; }
  }
  if (fs.existsSync(path.join(cwd, ".claude/.git")) || process.platform === "win32") return false;
  const result = childProcess.spawnSync("/usr/bin/git", ["-c", "core.fsmonitor=false", "--no-optional-locks", "-C", cwd, "ls-files", "--error-unmatch", "--", ":(icase).claude/settings.local.json"], {
    encoding: "utf8", timeout: 2000,
    env: { ...process.env, GIT_LITERAL_PATHSPECS: "", GIT_TRACE2: "", GIT_TRACE2_PERF: "", GIT_TRACE2_EVENT: "" },
  });
  return !result.error && result.signal === null && result.status === 1;
}

/** Only user decisions can approve repository executables. Repository settings can reject them. */
export function claudeProjectMcpDecisions(cwd: string): { approved(name: string): boolean; disabled(name: string): boolean } {
  const configFile = [path.join(getSettings().claude.configPath, ".claude.json"), path.join(os.homedir(), ".claude.json")].find((file) => fs.existsSync(file));
  const legacy = object(object(configFile ? json(configFile).projects : undefined)[cwd]);
  const local = json(path.join(cwd, ".claude/settings.local.json"));
  const project = json(path.join(cwd, ".claude/settings.json"));
  const user = json(path.join(getSettings().claude.configPath, "settings.json"));
  const approvals = [legacy, user, ...(untrackedLocalSettings(cwd) ? [local] : [])];
  const normalize = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const includes = (settings: Record<string, unknown>, key: string, name: string): boolean => Array.isArray(settings[key]) && settings[key].some((entry) => typeof entry === "string" && (name.startsWith("plugin:") || entry.startsWith("plugin:") ? entry === name : normalize(entry) === normalize(name)));
  const disabled = (name: string): boolean => [legacy, user, local, project].some((settings) => includes(settings, "disabledMcpjsonServers", name) || includes(settings, "disabledMcpServers", name));
  return { disabled, approved: (name) => !disabled(name) && approvals.some((settings) => settings.enableAllProjectMcpServers === true || includes(settings, "enabledMcpjsonServers", name)) };
}

export function claudeEnterpriseMcpPath(): string {
  return path.join(process.platform === "darwin" ? "/Library/Application Support/ClaudeCode" : process.platform === "win32" ? "C:\\Program Files\\ClaudeCode" : "/etc/claude-code", "managed-mcp.json");
}

/** Materialize the pinned CLI's directory-plugin MCP format, without executing plugin code. */
export function claudePluginMcpServers(plugin: string, cwd: string): Record<string, unknown> {
  if (plugin.endsWith(".zip")) throw new Error("Strict isolation cannot load zipped Claude plugins; unpack the managed plugin first");
  const manifest = json(path.join(plugin, ".claude-plugin/plugin.json"));
  const agentRoots = [path.join(plugin, "agents"), ...[manifest.agents].flat().filter((value): value is string => typeof value === "string").map((value) => path.resolve(plugin, value))];
  for (const root of agentRoots) for (const file of managedMarkdownFiles(root)) {
    const frontmatter = fs.readFileSync(file, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (frontmatter && object(parseYaml(frontmatter[1])).mcpServers !== undefined) throw new Error(`Strict isolation does not support agent frontmatter mcpServers: ${file}. Move these servers to the managed plugin MCP config.`);
  }
  const load = (file: string): Record<string, unknown> => { const config = json(file); return object(config.mcpServers ?? config); };
  const servers = load(path.join(plugin, ".mcp.json"));
  for (const source of [manifest.mcpServers ?? []].flat()) {
    if (typeof source === "string") {
      if (/\.mcpb$|:\/\//i.test(source)) throw new Error(`Strict isolation does not support MCP bundles: ${plugin}`);
      Object.assign(servers, load(path.resolve(plugin, source)));
    } else Object.assign(servers, object(source));
  }
  if (!Object.keys(servers).length) return {};
  const name = manifest.name;
  if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error(`Invalid managed plugin name at ${plugin}`);
  const cache = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
  const pluginRoot = cache ? path.resolve(cache.replace(/^~(?=\/|$)/, os.homedir())) : path.join(getSettings().claude.configPath, "plugins");
  const data = path.join(pluginRoot, "data", `${name}-inline`.replace(/[^a-zA-Z0-9_-]/g, "-"));
  const expand = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (value.includes("${user_config.")) throw new Error(`Strict isolation does not support plugin user_config MCP substitutions: ${plugin}`);
      return value.replaceAll("${CLAUDE_PLUGIN_ROOT}", plugin).replaceAll("${CLAUDE_PLUGIN_DATA}", data).replaceAll("${CLAUDE_PROJECT_DIR}", cwd);
    }
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]));
    return value;
  };
  return Object.fromEntries(Object.entries(servers).map(([serverName, value]) => {
    const server = object(expand(value));
    if (server.headersHelper !== undefined) throw new Error(`Strict isolation does not support plugin MCP headersHelper: ${plugin}. Configure explicit headers or a managed dynamic MCP server instead.`);
    if (!server.type || server.type === "stdio") {
      fs.mkdirSync(data, { recursive: true });
      server.env = { CLAUDE_PLUGIN_ROOT: plugin, CLAUDE_PLUGIN_DATA: data, ...object(server.env) };
    }
    // Ordinary ${VAR} and ${VAR:-default} expansion remains the CLI's responsibility.
    return [`plugin:${name}:${serverName}`, server];
  }));
}

function isolatedMcpConfig(servers: Record<string, unknown>): string {
  const content = JSON.stringify({ mcpServers: servers });
  const directory = path.join(resolveDataDirectory(), "runtime", "claude-mcp");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${createHash("sha256").update(content).digest("hex")}.json`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, file);
  return file;
}

/** The project settings an agent still needs, carried by the app instead of the CLI's own discovery. */
const REPLICATED_PROJECT_SETTINGS = ["hooks", "env", "permissions"] as const;

/** Hooks, env and permission rules from the project's `.claude/settings.json` and its untracked local file. */
export function claudeProjectSettingsReplica(cwd: string): Record<string, unknown> {
  const sources = [json(path.join(cwd, ".claude/settings.json")), ...(untrackedLocalSettings(cwd) ? [json(path.join(cwd, ".claude/settings.local.json"))] : [])];
  const hooks: Record<string, unknown[]> = {};
  const env: Record<string, unknown> = {};
  const permissions: Record<string, unknown[]> = {};
  for (const source of sources) {
    for (const [event, matchers] of Object.entries(object(source.hooks))) if (Array.isArray(matchers)) (hooks[event] ??= []).push(...matchers);
    Object.assign(env, object(source.env));
    for (const [kind, rules] of Object.entries(object(source.permissions))) if (Array.isArray(rules)) (permissions[kind] ??= []).push(...rules);
  }
  const replica: Record<string, unknown> = { hooks, env, permissions };
  return Object.fromEntries(REPLICATED_PROJECT_SETTINGS.filter((key) => Object.keys(object(replica[key])).length).map((key) => [key, replica[key]]));
}

function isolatedSettings(cwd: string, memoryDirectory: string | undefined): string {
  // The built-in agents-md plugin would read the project's AGENTS.md itself; the app passes it instead.
  // Memory lives in the app's folder for the project, never in ~/.claude; runs without one keep none.
  const memory = memoryDirectory ? { autoMemoryDirectory: memoryDirectory } : { autoMemoryEnabled: false };
  const content = JSON.stringify({ ...claudeProjectSettingsReplica(cwd), ...memory, enabledPlugins: { "agents-md@builtin": false, "cc-plugin-agents-md@builtin": false } });
  const directory = path.join(resolveDataDirectory(), "runtime", "claude-settings");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${createHash("sha256").update(content).digest("hex")}.json`);
  if (fs.existsSync(file)) return file;
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, file);
  return file;
}

/** Org memory comes from the claude.ai account, not from the app. */
export function claudeIsolationEnvironment(): NodeJS.ProcessEnv {
  return getSettings().strictResourceIsolation ? { CLAUDE_CODE_DISABLE_ORG_MEMORY: "1" } : {};
}

export function claudeResourceIsolationArgs(cwd: string, resources: string[], memoryDirectory?: string): string[] {
  if (!getSettings().strictResourceIsolation) {
    assertNoBlockedNativeResources("claude", "mcp");
    return resources;
  }
  // No setting source at all: the CLI then discovers no CLAUDE.md, rules, skills, agents, commands or
  // hooks in the project or its parents, and the app passes what the agent should have.
  const args = ["--setting-sources", "", "--settings", isolatedSettings(cwd, memoryDirectory)];
  // The pinned CLI gives this file exclusive MCP control. Never send dynamic servers or the conflicting strict flag.
  const enterprise = fs.existsSync(claudeEnterpriseMcpPath());
  if (enterprise) {
    // Claude 2.1.239 c8r/u8r: only the root shape/read gate is fatal;
    // invalid individual servers are skipped but enterprise exclusivity remains.
    const stat = fs.statSync(claudeEnterpriseMcpPath());
    if (!stat.isFile() || stat.size > 2097152) throw new Error("Strict isolation refuses an unreadable or oversized enterprise MCP config");
    const map = json(claudeEnterpriseMcpPath()).mcpServers;
    if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error("Strict isolation refuses an invalid enterprise MCP config");
    if (Object.keys(activeMcpServers("claude", object(map))).length !== Object.keys(map).length) throw new Error("Cannot safely suppress a blocked enterprise MCP server");
  } else args.push("--strict-mcp-config");
  const servers: Record<string, unknown> = {};
  for (let i = 0; i < resources.length; i++) {
    const arg = resources[i];
    if (arg === "--mcp-config") {
      while (i + 1 < resources.length && !resources[i + 1].startsWith("--")) {
        const file = resources[++i];
        if (!enterprise) Object.assign(servers, object(json(file).mcpServers));
      }
    } else {
      args.push(arg);
      if (arg === "--plugin-dir" && resources[i + 1] && !enterprise) Object.assign(servers, claudePluginMcpServers(path.resolve(resources[i + 1]), cwd));
    }
  }
  if (!enterprise) {
    const decisions = claudeProjectMcpDecisions(cwd);
    for (const [name, server] of Object.entries(object(json(path.join(cwd, ".mcp.json")).mcpServers))) {
      if (!decisions.approved(name)) continue;
      if (object(server).headersHelper !== undefined) throw new Error(`Strict isolation does not support project MCP headersHelper: ${name}. Configure explicit headers or a managed dynamic MCP server instead.`);
      servers[name] = server;
    }
    for (const name of Object.keys(servers)) if (decisions.disabled(name)) delete servers[name];
    const active = activeMcpServers("claude", servers);
    if (Object.keys(active).length) args.push("--mcp-config", isolatedMcpConfig(active));
  }
  return args;
}

function missing(error: unknown): boolean { const code = (error as NodeJS.ErrnoException).code; return code === "ENOENT" || code === "ENOTDIR"; }
function pluginInvocation(skill: SkillSummary): SkillSummary { return { ...skill, invocation: `/joint-bob-resources:${skill.name} ` }; }
async function skills(projectPath: string, roots: SkillRoots): Promise<SkillSummary[]> {
  const strict = getSettings().strictResourceIsolation;
  const userRoot = strict ? undefined : (roots.claudeUser ?? roots.user?.claude);
  // Under strict isolation the project's own skills reach Claude through the app's plugin, from every
  // harness's folder; Claude still answers to their bare names.
  const projectSkills = (strict ? projectFolderResources(projectPath).skills : [path.join(projectPath, ".agents", "skills"), path.join(projectPath, ".claude", "skills")])
    .map((root) => readSkillDirectory(root, "claude", "project"));
  const sources = await Promise.all([
    ...(userRoot ? [readSkillDirectory(userRoot, "claude", "user")] : []),
    readSkillDirectory(roots.shared, "claude", "user").then((items) => items.map(pluginInvocation)),
    ...(roots.global ?? []).map((root) => readConfiguredSkillPath(root, "claude", "user").then((items) => items.map(pluginInvocation))),
    ...projectSkills,
    ...(roots.project ?? []).map((root) => readConfiguredSkillPath(root, "claude", "project").then((items) => items.map(pluginInvocation))),
  ]);
  return sources.flat().map((skill) => ({ ...skill, invocation: skill.invocation ?? `/${skill.name} ` }));
}
async function markdownCommand(file: string, scope: "user" | "project", prefix = "/"): Promise<HarnessCommand | undefined> {
  try { const fields = parseResourceFrontmatter(await readFile(file, "utf8")); const name = path.basename(file, ".md"); return { harness: "claude", name, description: fields.description ?? "", invocation: `${prefix}${name} `, kind: "prompt", scope }; }
  catch (error) { if (missing(error)) return undefined; throw error; }
}
async function markdownCommands(root: string, scope: "user" | "project", prefix = "/"): Promise<HarnessCommand[]> {
  if (root.endsWith(".md")) { const command = await markdownCommand(root, scope, prefix); return command ? [command] : []; }
  return (await Promise.all(managedMarkdownFiles(root).map(async (file) => {
    const command = await markdownCommand(file, scope, prefix);
    const name = path.relative(root, file).slice(0, -3).split(path.sep).join(":");
    return command ? { ...command, name, invocation: `${prefix}${name} ` } : undefined;
  }))).filter((item): item is HarnessCommand => Boolean(item));
}
async function commands(projectPath: string, options: CommandDiscoveryOptions): Promise<HarnessCommand[]> {
  const strict = getSettings().strictResourceIsolation;
  const roots = { ...defaultSkillRoots(), ...options, user: { ...defaultSkillRoots().user, ...options.user }, global: options.resourcePaths?.global.skills ?? options.global ?? [], project: options.resourcePaths?.project.skills ?? options.project ?? [] };
  const config = options.claudeConfigPath ?? getSettings().claude.configPath;
  const discoveredSkills = await skills(projectPath, roots);
  const custom = options.resourcePaths ? await Promise.all([...options.resourcePaths.global.prompts.map((root) => markdownCommands(root, "user", "/joint-bob-resources:")), ...options.resourcePaths.project.prompts.map((root) => markdownCommands(root, "project", "/joint-bob-resources:"))]) : [];
  const nativeCommands = strict ? [] : await markdownCommands(path.join(config, "commands"), "user");
  const projectCommands = (await Promise.all((strict ? projectFolderResources(projectPath).prompts : [path.join(projectPath, ".claude", "commands")])
    .map((root) => markdownCommands(root, "project")))).flat();
  return [...builtinCommands("claude"), { harness: "claude", name: "goal", description: "Set a completion condition", invocation: "/goal ", kind: "builtin" }, ...nativeCommands, ...await markdownCommands(agentResourcePaths(options.resourceRoot).claudeCommands, "user", "/joint-bob-resources:"), ...discoveredSkills.map((skill): HarnessCommand => ({ harness: "claude", name: skill.name, description: skill.description, invocation: skill.invocation!, kind: "skill", scope: skill.scope })), ...projectCommands, ...custom.flat()];
}
const resources: HarnessResources = { skills, commands };
export default resources;
