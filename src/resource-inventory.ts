import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { runtimeHome } from "./account-runtime.js";
import os from "node:os";
import path from "node:path";
import { agentResourcePaths, blockedPluginSkill, claudePluginSources, pluginActivationDecisions } from "./agent-resources.js";
import { activationDecision, receivedResource, receivedSkill, skillNameFromFile, type ActivationDecision } from "./resource-activation.js";
import { claudeEnterpriseMcpPath, claudePluginMcpServers, claudeProjectMcpDecisions } from "./harnesses/claude/resources.js";
import { listDiscoveredHarnesses } from "./harnesses/registry.js";
import { configuredRuntime } from "./harnesses/runtime-configuration.js";
import { defaultSkillRoots, listSkills } from "./skills.js";
import { getScopedResourcePaths, getSettings } from "./settings.js";
import { scopedSkillsRoot } from "./scoped-skills.js";
import type { HarnessId } from "./types.js";

/** Harnesses whose runs load MCP servers; Pi has no MCP client. */
const MCP_HARNESSES: HarnessId[] = ["claude", "kiro"];

export type SkillOrigin = "shared" | "scoped" | "user" | "project";

export interface InventorySkill {
  name: string;
  description: string;
  origin: SkillOrigin;
  path: string;
  harnesses: HarnessId[];
  activation?: Partial<Record<HarnessId, ActivationDecision>>;
}

export type McpSource = "shared" | "user" | "local" | "project" | "plugin" | "enterprise";

export interface InventoryMcpServer {
  name: string;
  source: McpSource;
  /** The config file the server comes from. */
  file: string;
  harnesses: HarnessId[];
  transport: "stdio" | "http" | "sse";
  /** The command name or URL origin; never arguments, headers or environment values. */
  target: string;
  enabled: boolean;
  activation?: Partial<Record<HarnessId, ActivationDecision>>;
}

export interface InventoryPlugin {
  name: string;
  file: string;
  source: "managed" | "project" | "extension" | "configured" | "unverified";
  harnesses: HarnessId[];
  activation: Partial<Record<HarnessId, ActivationDecision>>;
}

export interface ResourceInventory {
  harnesses: Array<{ id: HarnessId; label: string; mcp: boolean }>;
  skills: InventorySkill[];
  mcpServers: InventoryMcpServer[];
  plugins: InventoryPlugin[];
  sharedSkillsPath: string;
  mcpConfigPath: string;
}

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function resolved(candidate: string): Promise<string> {
  try { return await realpath(candidate); } catch (error) { if (missing(error)) return path.resolve(candidate); throw error; }
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch (error) {
    // A missing or hand-edited broken config simply contributes no servers here.
    if (missing(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function pluginPackageSource(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const source = record(value).source;
  return typeof source === "string" ? source : undefined;
}

function pluginPackageLabel(source: string): string {
  if (source.startsWith("npm:")) return source.slice(4).match(/^(@[^/]+\/[^@]+|[^@]+)(?:@.*)?$/)?.[1] ?? "Pi package";
  try {
    const url = new URL(source);
    return url.hostname || "Pi package";
  } catch { return path.basename(source.split(/[?#]/, 1)[0]).replace(/\.git$/, "") || "Pi package"; }
}

async function configuredPiExtensionPaths(source: string): Promise<string[]> {
  const candidate = source.startsWith("~/") ? path.join(os.homedir(), source.slice(2)) : path.resolve(source);
  try {
    const info = await stat(candidate);
    if (info.isFile()) return /\.[cm]?[jt]s$/i.test(candidate) ? [candidate] : [];
    if (!info.isDirectory()) return [];
    const manifest = await readJson(path.join(candidate, "package.json"));
    const extensionList = typeof manifest?.pi === "object" && manifest.pi !== null ? record(manifest.pi).extensions : undefined;
    const paths = (typeof extensionList === "string" ? [extensionList] : strings(extensionList)).map((entry) => path.resolve(candidate, entry));
    if (paths.length) return paths;
    const files = (await readdir(candidate, { withFileTypes: true }))
      .filter((entry) => /\.[cm]?[jt]s$/i.test(entry.name) && (entry.isFile() || entry.isSymbolicLink()))
      .map((entry) => path.join(candidate, entry.name));
    return files.length ? files : [candidate];
  } catch (error) { if (missing(error)) return []; throw error; }
}

function describeServer(value: unknown): Pick<InventoryMcpServer, "transport" | "target"> | undefined {
  const server = record(value);
  if (typeof server.command === "string" && server.command) return { transport: "stdio", target: path.basename(server.command) };
  if (typeof server.url === "string" && server.url) {
    let target = "remote";
    try { target = new URL(server.url).origin; } catch { /* keep the generic label rather than echo a malformed URL */ }
    return { transport: server.type === "sse" ? "sse" : "http", target };
  }
  return undefined;
}

function servers(map: unknown, base: Omit<InventoryMcpServer, "name" | "transport" | "target" | "enabled">, disabled: string[] = []): InventoryMcpServer[] {
  return Object.entries(record(map)).flatMap(([name, value]) => {
    const described = describeServer(value);
    return described ? [{ name, ...base, ...described, enabled: !disabled.includes(name) && record(value).disabled !== true }] : [];
  });
}

function inspectPlugin(plugin: string, decision: ActivationDecision): { decision: ActivationDecision; verified: boolean } {
  try {
    const blockedSkill = blockedPluginSkill(plugin);
    return blockedSkill
      ? { decision: { ...decision, enabled: false, reason: `Contains blocked skill ${blockedSkill}` }, verified: true }
      : { decision, verified: true };
  } catch {
    return { decision: { ...decision, enabled: false, reason: "Plugin contents could not be safely inspected" }, verified: false };
  }
}

function runtimeConfigPath(id: HarnessId): string | undefined {
  const adapter = listDiscoveredHarnesses().find((candidate) => candidate.id === id);
  if (!adapter?.configuration) return undefined;
  return configuredRuntime(adapter.id, adapter.configuration.defaults(runtimeHome())).configPath;
}

async function claudeServers(projectPath: string | undefined): Promise<InventoryMcpServer[]> {
  const configPath = runtimeConfigPath("claude");
  const candidates = [...(configPath ? [path.join(configPath, ".claude.json")] : []), path.join(os.homedir(), ".claude.json")];
  const found: InventoryMcpServer[] = [];
  let projectSettings: Record<string, unknown> = {};
  for (const file of candidates) {
    const config = await readJson(file);
    if (!config) continue;
    found.push(...servers(config.mcpServers, { source: "user", file, harnesses: ["claude"] }));
    if (projectPath) {
      projectSettings = record(record(config.projects)[projectPath]);
      found.push(...servers(projectSettings.mcpServers, { source: "local", file, harnesses: ["claude"] }, strings(projectSettings.disabledMcpServers)));
    }
    break;
  }
  if (projectPath) {
    const file = path.join(projectPath, ".mcp.json");
    const config = await readJson(file);
    const decisions = claudeProjectMcpDecisions(projectPath);
    const unapproved = Object.keys(record(config?.mcpServers)).filter((name) => !decisions.approved(name));
    if (config) found.push(...servers(config.mcpServers, { source: "project", file, harnesses: ["claude"] }, unapproved));
  }
  return found;
}

async function pluginServers(pluginsRoot: string): Promise<InventoryMcpServer[]> {
  let entries;
  try { entries = await readdir(pluginsRoot, { withFileTypes: true }); } catch (error) { if (missing(error)) return []; throw error; }
  const found = await Promise.all(entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map(async (entry) => {
    const file = path.join(pluginsRoot, entry.name, ".mcp.json");
    if (getSettings().strictResourceIsolation) {
      const plugin = path.dirname(file);
      if (!await readJson(path.join(plugin, ".claude-plugin/plugin.json"))) return [];
      return servers(claudePluginMcpServers(plugin, process.cwd()), { source: "plugin", file: path.join(plugin, ".claude-plugin/plugin.json"), harnesses: ["claude"] });
    }
    const config = await readJson(file);
    if (!config) return [];
    return servers(config.mcpServers ?? config, { source: "plugin", file, harnesses: ["claude"] });
  }));
  return found.flat();
}

async function kiroServers(projectPath: string | undefined): Promise<InventoryMcpServer[]> {
  const configPath = runtimeConfigPath("kiro");
  const files: Array<{ file: string; source: McpSource }> = [
    ...(configPath ? [{ file: path.join(configPath, "settings/mcp.json"), source: "user" as const }] : []),
    ...(projectPath ? [{ file: path.join(projectPath, ".kiro/settings/mcp.json"), source: "project" as const }] : []),
  ];
  const found = await Promise.all(files.map(async ({ file, source }) => servers((await readJson(file))?.mcpServers, { source, file, harnesses: ["kiro"] })));
  return found.flat();
}

/** Lists MCP servers each harness loads on this node, optionally including one project's servers. */
export async function listMcpServers(projectPath?: string, resourceRoot?: string): Promise<InventoryMcpServer[]> {
  const strict = getSettings().strictResourceIsolation;
  const paths = agentResourcePaths(resourceRoot);
  const discovered = new Set(listDiscoveredHarnesses().map((adapter) => adapter.id));
  const shared = servers((await readJson(paths.mcpConfig))?.mcpServers, { source: "shared", file: paths.mcpConfig, harnesses: MCP_HARNESSES.filter((id) => discovered.has(id)) });
  const enterprise = discovered.has("claude") ? await readJson(claudeEnterpriseMcpPath()) : undefined;
  const groups = await Promise.all([
    discovered.has("claude") ? claudeServers(projectPath) : [],
    discovered.has("claude") && !enterprise ? pluginServers(paths.claudePlugins) : [],
    discovered.has("kiro") ? kiroServers(projectPath) : [],
  ]);
  const decisions = projectPath ? claudeProjectMcpDecisions(projectPath) : undefined;
  const entries = [...shared, ...groups.flat(), ...servers(enterprise?.mcpServers, { source: "enterprise", file: claudeEnterpriseMcpPath(), harnesses: ["claude"] })]
    .map((server) => {
      const activation = Object.fromEntries(server.harnesses.map((harness) => [harness,
        activationDecision("mcp", server.name, harness, server.source === "shared" && receivedResource("mcp", server.name))]));
      return { ...server, activation, enabled: server.enabled && server.harnesses.some((harness) => activation[harness].enabled) };
    });
  return entries.flatMap((server) => {
    if (!strict) return [server];
    if (["user", "local"].includes(server.source)) return [{ ...server, enabled: false }];
    if (server.source !== "enterprise" && server.harnesses.includes("claude") && (enterprise || decisions?.disabled(server.name))) {
      const others = server.harnesses.filter((id) => id !== "claude");
      return [{ ...server, harnesses: ["claude" as const], enabled: false }, ...(others.length ? [{ ...server, harnesses: others }] : [])];
    }
    return [server];
  });
}

async function inventorySkills(projectPath: string | undefined, projectId: string | undefined, sharedRoot: string, conversationId?: string): Promise<InventorySkill[]> {
  const configured = getScopedResourcePaths(projectId, conversationId);
  // Without a project, only user-level skills apply; a path that cannot exist keeps project roots empty.
  const summaries = await listSkills(projectPath ?? path.join(os.tmpdir(), "joint-bob-no-project"), { ...defaultSkillRoots(), shared: sharedRoot, global: configured.global.skills, project: projectPath ? configured.project.skills : [] });
  const shared = await resolved(sharedRoot);
  const scoped = await resolved(scopedSkillsRoot());
  const byKey = new Map<string, InventorySkill>();
  for (const summary of summaries) {
    const discovered = summary.path ?? "";
    const location = await resolved(discovered);
    let discoveredIsFile = false;
    try { discoveredIsFile = Boolean(discovered && existsSync(discovered) && statSync(discovered).isFile()); }
    catch { /* If the discovery path changed or became unreadable, use its canonical fallback. */ }
    const sourceManifest = path.basename(discovered) === "SKILL.md" || discoveredIsFile ? discovered : path.join(discovered, "SKILL.md");
    const canonicalManifest = path.basename(location) === "SKILL.md" ? location : path.join(location, "SKILL.md");
    const manifest = existsSync(sourceManifest) ? sourceManifest : canonicalManifest;
    let name = summary.name;
    try { if (existsSync(manifest)) name = skillNameFromFile(manifest, path.basename(path.dirname(manifest))); }
    catch { continue; } // A malformed resource must not break the rest of the inventory or receive an enabled identity.
    const origin: SkillOrigin = inside(scoped, location) ? "scoped" : summary.scope === "project" ? "project" : inside(shared, location) ? "shared" : "user";
    const key = `${origin}\0${name}`;
    const existing = byKey.get(key);
    if (existing) { if (!existing.harnesses.includes(summary.harness)) existing.harnesses.push(summary.harness); continue; }
    byKey.set(key, { name, description: summary.description, origin, path: location, harnesses: [summary.harness] });
  }
  return [...byKey.values()].map((skill) => ({ ...skill, activation: Object.fromEntries(skill.harnesses.map((harness) => [harness,
    activationDecision("skill", skill.name, harness, skill.origin === "scoped" || skill.origin === "shared" && receivedSkill(path.basename(skill.path), sharedRoot))])) }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.origin.localeCompare(right.origin));
}

/** Everything this node would load: skills per harness and MCP servers, for one project or node-wide. */
export async function resourceInventory(options: { projectPath?: string; projectId?: string; conversationId?: string; resourceRoot?: string } = {}): Promise<ResourceInventory> {
  const paths = agentResourcePaths(options.resourceRoot);
  const [skills, mcpServers] = await Promise.all([
    inventorySkills(options.projectPath, options.projectId, paths.sharedSkills, options.conversationId),
    listMcpServers(options.projectPath, options.resourceRoot),
  ]);
  const harnesses = listDiscoveredHarnesses().map((adapter) => ({ id: adapter.id, label: adapter.label, mcp: MCP_HARNESSES.includes(adapter.id) }));
  const plugins: InventoryPlugin[] = [];
  try {
    const seenManaged = new Set<string>();
    for (const entry of await readdir(paths.claudePlugins, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const plugin = path.join(paths.claudePlugins, entry.name);
      const file = path.join(plugin, ".claude-plugin/plugin.json");
      if (!await readJson(file)) continue;
      const decisions = pluginActivationDecisions(plugin, paths.claudePlugins);
      const canonical = await resolved(plugin);
      for (const { name, decision } of decisions) {
        const key = JSON.stringify([canonical, name]);
        if (seenManaged.has(key)) continue;
        seenManaged.add(key);
        const inspected = inspectPlugin(plugin, decision);
        plugins.push({ name, file, source: inspected.verified ? "managed" : "unverified", harnesses: ["claude"],
          activation: { claude: inspected.decision } });
      }
    }
  } catch (error) { if (!missing(error)) throw error; }
  try {
    for (const entry of await readdir(paths.piExtensions, { withFileTypes: true })) {
      const file = path.join(paths.piExtensions, entry.name);
      if (!entry.isDirectory() && !entry.isFile()) continue;
      if (entry.isFile() && !/\.[cm]?[jt]s$/.test(entry.name)) continue;
      plugins.push({ name: entry.name, file, source: "extension", harnesses: ["pi"],
        activation: { pi: activationDecision("plugin", entry.name, "pi", false) } });
    }
  } catch (error) { if (!missing(error)) throw error; }
  const configured = options.projectPath ? getScopedResourcePaths(options.projectId, options.conversationId) : undefined;
  if (configured) {
    const seenClaude = new Set<string>();
    for (const plugin of claudePluginSources([...configured.global.plugins, ...configured.project.plugins])) {
      const canonical = await resolved(plugin);
      const decisions = pluginActivationDecisions(plugin, paths.claudePlugins);
      for (const { name, decision } of decisions) {
        const key = JSON.stringify([canonical, name]);
        if (seenClaude.has(key)) continue;
        seenClaude.add(key);
        const inspected = inspectPlugin(plugin, decision);
        plugins.push({ name, file: plugin, source: inspected.verified ? "project" : "unverified", harnesses: ["claude"],
          activation: { claude: inspected.decision } });
      }
    }
    const seenPi = new Set<string>();
    for (const source of [...configured.global.plugins, ...configured.project.plugins]) {
      const discovered = await configuredPiExtensionPaths(source);
      const candidate = source.startsWith("~/") ? path.join(os.homedir(), source.slice(2)) : path.resolve(source);
      const files = discovered.length ? discovered : existsSync(candidate) ? [] : [source];
      for (const file of files) {
        const canonical = await resolved(file);
        if (seenPi.has(canonical)) continue;
        seenPi.add(canonical);
        plugins.push({ name: existsSync(file) ? path.basename(file) : pluginPackageLabel(file), file, source: "configured", harnesses: ["pi"], activation: {} });
      }
    }
  }
  const packageFiles = [
    ...(getSettings().strictResourceIsolation ? [paths.piPackages] : [path.join(getSettings().pi.configPath, "settings.json")]),
    ...(options.projectPath ? [path.join(options.projectPath, ".pi/settings.json")] : []),
  ];
  const seenPackages = new Set<string>();
  for (const file of packageFiles) {
    const config = await readJson(file);
    for (const value of Array.isArray(config?.packages) ? config.packages : []) {
      const source = pluginPackageSource(value);
      if (!source || seenPackages.has(source)) continue;
      seenPackages.add(source);
      plugins.push({ name: pluginPackageLabel(source), file, source: "configured", harnesses: ["pi"], activation: {} });
    }
  }
  return { harnesses, skills, mcpServers, plugins, sharedSkillsPath: paths.sharedSkills, mcpConfigPath: paths.mcpConfig };
}

/** Copies named servers from a local config into the shared MCP config that every node's Claude and Kiro load. */
export async function shareMcpServers(file: string, names: string[], options: { projectPath?: string; resourceRoot?: string } = {}): Promise<{ added: string[]; skipped: string[] }> {
  const paths = agentResourcePaths(options.resourceRoot);
  if (path.resolve(file) === path.resolve(paths.mcpConfig)) throw new Error("Servers are already shared");
  const known = (await listMcpServers(options.projectPath, options.resourceRoot)).filter((server) => server.source !== "shared");
  const source = known.find((server) => server.file === file);
  if (!source) throw new Error("Unknown MCP config source");
  const config = source.source === "plugin" && getSettings().strictResourceIsolation
    ? { mcpServers: claudePluginMcpServers(path.dirname(path.dirname(file)), options.projectPath ?? process.cwd()) }
    : await readJson(file);
  if (!config) throw new Error("MCP config source is unreadable");
  const pools = [record(config.mcpServers), ...(options.projectPath ? [record(record(record(config.projects)[options.projectPath]).mcpServers)] : [])];
  const current = (await readJson(paths.mcpConfig)) ?? {};
  const shared = { ...record(current.mcpServers) };
  const added: string[] = [], skipped: string[] = [];
  for (const name of names) {
    const value = pools.map((pool) => pool[name]).find((candidate) => describeServer(candidate));
    if (!value || shared[name] !== undefined) { skipped.push(name); continue; }
    shared[name] = value;
    added.push(name);
  }
  if (added.length) {
    await mkdir(path.dirname(paths.mcpConfig), { recursive: true });
    const temporary = `${paths.mcpConfig}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ ...current, mcpServers: shared }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, paths.mcpConfig);
  }
  return { added, skipped };
}
