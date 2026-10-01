import { mkdir, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agentResourcePaths } from "./agent-resources.js";
import { listDiscoveredHarnesses } from "./harnesses/registry.js";
import { configuredRuntime } from "./harnesses/runtime-configuration.js";
import { defaultSkillRoots, listSkills } from "./skills.js";
import { getScopedResourcePaths } from "./settings.js";
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
}

export type McpSource = "shared" | "user" | "local" | "project" | "plugin";

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
}

export interface ResourceInventory {
  harnesses: Array<{ id: HarnessId; label: string; mcp: boolean }>;
  skills: InventorySkill[];
  mcpServers: InventoryMcpServer[];
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

function runtimeConfigPath(id: HarnessId): string | undefined {
  const adapter = listDiscoveredHarnesses().find((candidate) => candidate.id === id);
  if (!adapter?.configuration) return undefined;
  return configuredRuntime(adapter.id, adapter.configuration.defaults(os.homedir())).configPath;
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
    const enabled = strings(projectSettings.enabledMcpjsonServers);
    const disabled = strings(projectSettings.disabledMcpjsonServers);
    // Claude asks before using project servers; only an explicit approval makes them run unattended.
    const unapproved = projectSettings.enableAllProjectMcpServers === true ? [] : Object.keys(record(config?.mcpServers)).filter((name) => !enabled.includes(name));
    if (config) found.push(...servers(config.mcpServers, { source: "project", file, harnesses: ["claude"] }, [...disabled, ...unapproved]));
  }
  return found;
}

async function pluginServers(pluginsRoot: string): Promise<InventoryMcpServer[]> {
  let entries;
  try { entries = await readdir(pluginsRoot, { withFileTypes: true }); } catch (error) { if (missing(error)) return []; throw error; }
  const found = await Promise.all(entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map(async (entry) => {
    const file = path.join(pluginsRoot, entry.name, ".mcp.json");
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
  const paths = agentResourcePaths(resourceRoot);
  const discovered = new Set(listDiscoveredHarnesses().map((adapter) => adapter.id));
  const shared = servers((await readJson(paths.mcpConfig))?.mcpServers, { source: "shared", file: paths.mcpConfig, harnesses: MCP_HARNESSES.filter((id) => discovered.has(id)) });
  const groups = await Promise.all([
    discovered.has("claude") ? claudeServers(projectPath) : [],
    discovered.has("claude") ? pluginServers(paths.claudePlugins) : [],
    discovered.has("kiro") ? kiroServers(projectPath) : [],
  ]);
  return [...shared, ...groups.flat()];
}

async function inventorySkills(projectPath: string | undefined, projectId: string | undefined, sharedRoot: string, conversationId?: string): Promise<InventorySkill[]> {
  const configured = getScopedResourcePaths(projectId, conversationId);
  // Without a project, only user-level skills apply; a path that cannot exist keeps project roots empty.
  const summaries = await listSkills(projectPath ?? path.join(os.tmpdir(), "joint-bob-no-project"), { ...defaultSkillRoots(), shared: sharedRoot, global: configured.global.skills, project: projectPath ? configured.project.skills : [] });
  const shared = await resolved(sharedRoot);
  const scoped = await resolved(scopedSkillsRoot());
  const byKey = new Map<string, InventorySkill>();
  for (const summary of summaries) {
    const location = await resolved(summary.path ?? "");
    const origin: SkillOrigin = inside(scoped, location) ? "scoped" : summary.scope === "project" ? "project" : inside(shared, location) ? "shared" : "user";
    const key = `${origin}\0${summary.name}`;
    const existing = byKey.get(key);
    if (existing) { if (!existing.harnesses.includes(summary.harness)) existing.harnesses.push(summary.harness); continue; }
    byKey.set(key, { name: summary.name, description: summary.description, origin, path: location, harnesses: [summary.harness] });
  }
  return [...byKey.values()].sort((left, right) => left.name.localeCompare(right.name) || left.origin.localeCompare(right.origin));
}

/** Everything this node would load: skills per harness and MCP servers, for one project or node-wide. */
export async function resourceInventory(options: { projectPath?: string; projectId?: string; conversationId?: string; resourceRoot?: string } = {}): Promise<ResourceInventory> {
  const paths = agentResourcePaths(options.resourceRoot);
  const [skills, mcpServers] = await Promise.all([
    inventorySkills(options.projectPath, options.projectId, paths.sharedSkills, options.conversationId),
    listMcpServers(options.projectPath, options.resourceRoot),
  ]);
  const harnesses = listDiscoveredHarnesses().map((adapter) => ({ id: adapter.id, label: adapter.label, mcp: MCP_HARNESSES.includes(adapter.id) }));
  return { harnesses, skills, mcpServers, sharedSkillsPath: paths.sharedSkills, mcpConfigPath: paths.mcpConfig };
}

/** Copies named servers from a local config into the shared MCP config that every node's Claude and Kiro load. */
export async function shareMcpServers(file: string, names: string[], options: { projectPath?: string; resourceRoot?: string } = {}): Promise<{ added: string[]; skipped: string[] }> {
  const paths = agentResourcePaths(options.resourceRoot);
  if (path.resolve(file) === path.resolve(paths.mcpConfig)) throw new Error("Servers are already shared");
  const known = (await listMcpServers(options.projectPath, options.resourceRoot)).filter((server) => server.source !== "shared").map((server) => server.file);
  if (!known.includes(file)) throw new Error("Unknown MCP config source");
  const config = await readJson(file);
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
