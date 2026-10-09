import { mkdir, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agentResourcePaths } from "./agent-resources.js";
import { listDiscoveredHarnesses } from "./harnesses/registry.js";
import { configuredRuntime } from "./harnesses/runtime-configuration.js";
import { defaultSkillRoots, listSkills } from "./skills.js";
import { getScopedResourcePaths } from "./settings.js";
import { scopedSkillsRoot } from "./scoped-skills.js";
const MCP_HARNESSES = ["claude", "kiro"];
function missing(error) {
  const code = error.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
async function resolved(candidate) {
  try {
    return await realpath(candidate);
  } catch (error) {
    if (missing(error)) return path.resolve(candidate);
    throw error;
  }
}
function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
}
async function readJson(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
  } catch (error) {
    if (missing(error) || error instanceof SyntaxError) return void 0;
    throw error;
  }
}
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function strings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
function describeServer(value) {
  const server = record(value);
  if (typeof server.command === "string" && server.command) return { transport: "stdio", target: path.basename(server.command) };
  if (typeof server.url === "string" && server.url) {
    let target = "remote";
    try {
      target = new URL(server.url).origin;
    } catch {
    }
    return { transport: server.type === "sse" ? "sse" : "http", target };
  }
  return void 0;
}
function servers(map, base, disabled = []) {
  return Object.entries(record(map)).flatMap(([name, value]) => {
    const described = describeServer(value);
    return described ? [{ name, ...base, ...described, enabled: !disabled.includes(name) && record(value).disabled !== true }] : [];
  });
}
function runtimeConfigPath(id) {
  const adapter = listDiscoveredHarnesses().find((candidate) => candidate.id === id);
  if (!adapter?.configuration) return void 0;
  return configuredRuntime(adapter.id, adapter.configuration.defaults(os.homedir())).configPath;
}
async function claudeServers(projectPath) {
  const configPath = runtimeConfigPath("claude");
  const candidates = [...configPath ? [path.join(configPath, ".claude.json")] : [], path.join(os.homedir(), ".claude.json")];
  const found = [];
  let projectSettings = {};
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
    const unapproved = projectSettings.enableAllProjectMcpServers === true ? [] : Object.keys(record(config?.mcpServers)).filter((name) => !enabled.includes(name));
    if (config) found.push(...servers(config.mcpServers, { source: "project", file, harnesses: ["claude"] }, [...disabled, ...unapproved]));
  }
  return found;
}
async function pluginServers(pluginsRoot) {
  let entries;
  try {
    entries = await readdir(pluginsRoot, { withFileTypes: true });
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  const found = await Promise.all(entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map(async (entry) => {
    const file = path.join(pluginsRoot, entry.name, ".mcp.json");
    const config = await readJson(file);
    if (!config) return [];
    return servers(config.mcpServers ?? config, { source: "plugin", file, harnesses: ["claude"] });
  }));
  return found.flat();
}
async function kiroServers(projectPath) {
  const configPath = runtimeConfigPath("kiro");
  const files = [
    ...configPath ? [{ file: path.join(configPath, "settings/mcp.json"), source: "user" }] : [],
    ...projectPath ? [{ file: path.join(projectPath, ".kiro/settings/mcp.json"), source: "project" }] : []
  ];
  const found = await Promise.all(files.map(async ({ file, source }) => servers((await readJson(file))?.mcpServers, { source, file, harnesses: ["kiro"] })));
  return found.flat();
}
async function listMcpServers(projectPath, resourceRoot) {
  const paths = agentResourcePaths(resourceRoot);
  const discovered = new Set(listDiscoveredHarnesses().map((adapter) => adapter.id));
  const shared = servers((await readJson(paths.mcpConfig))?.mcpServers, { source: "shared", file: paths.mcpConfig, harnesses: MCP_HARNESSES.filter((id) => discovered.has(id)) });
  const groups = await Promise.all([
    discovered.has("claude") ? claudeServers(projectPath) : [],
    discovered.has("claude") ? pluginServers(paths.claudePlugins) : [],
    discovered.has("kiro") ? kiroServers(projectPath) : []
  ]);
  return [...shared, ...groups.flat()];
}
async function inventorySkills(projectPath, projectId, sharedRoot, conversationId) {
  const configured = getScopedResourcePaths(projectId, conversationId);
  const summaries = await listSkills(projectPath ?? path.join(os.tmpdir(), "joint-bob-no-project"), { ...defaultSkillRoots(), shared: sharedRoot, global: configured.global.skills, project: projectPath ? configured.project.skills : [] });
  const shared = await resolved(sharedRoot);
  const scoped = await resolved(scopedSkillsRoot());
  const byKey = /* @__PURE__ */ new Map();
  for (const summary of summaries) {
    const location = await resolved(summary.path ?? "");
    const origin = inside(scoped, location) ? "scoped" : summary.scope === "project" ? "project" : inside(shared, location) ? "shared" : "user";
    const key = `${origin}\0${summary.name}`;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.harnesses.includes(summary.harness)) existing.harnesses.push(summary.harness);
      continue;
    }
    byKey.set(key, { name: summary.name, description: summary.description, origin, path: location, harnesses: [summary.harness] });
  }
  return [...byKey.values()].sort((left, right) => left.name.localeCompare(right.name) || left.origin.localeCompare(right.origin));
}
async function resourceInventory(options = {}) {
  const paths = agentResourcePaths(options.resourceRoot);
  const [skills, mcpServers] = await Promise.all([
    inventorySkills(options.projectPath, options.projectId, paths.sharedSkills, options.conversationId),
    listMcpServers(options.projectPath, options.resourceRoot)
  ]);
  const harnesses = listDiscoveredHarnesses().map((adapter) => ({ id: adapter.id, label: adapter.label, mcp: MCP_HARNESSES.includes(adapter.id) }));
  return { harnesses, skills, mcpServers, sharedSkillsPath: paths.sharedSkills, mcpConfigPath: paths.mcpConfig };
}
async function shareMcpServers(file, names, options = {}) {
  const paths = agentResourcePaths(options.resourceRoot);
  if (path.resolve(file) === path.resolve(paths.mcpConfig)) throw new Error("Servers are already shared");
  const known = (await listMcpServers(options.projectPath, options.resourceRoot)).filter((server) => server.source !== "shared").map((server) => server.file);
  if (!known.includes(file)) throw new Error("Unknown MCP config source");
  const config = await readJson(file);
  if (!config) throw new Error("MCP config source is unreadable");
  const pools = [record(config.mcpServers), ...options.projectPath ? [record(record(record(config.projects)[options.projectPath]).mcpServers)] : []];
  const current = await readJson(paths.mcpConfig) ?? {};
  const shared = { ...record(current.mcpServers) };
  const added = [], skipped = [];
  for (const name of names) {
    const value = pools.map((pool) => pool[name]).find((candidate) => describeServer(candidate));
    if (!value || shared[name] !== void 0) {
      skipped.push(name);
      continue;
    }
    shared[name] = value;
    added.push(name);
  }
  if (added.length) {
    await mkdir(path.dirname(paths.mcpConfig), { recursive: true });
    const temporary = `${paths.mcpConfig}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ ...current, mcpServers: shared }, null, 2)}
`, { mode: 384 });
    await rename(temporary, paths.mcpConfig);
  }
  return { added, skipped };
}
export {
  listMcpServers,
  resourceInventory,
  shareMcpServers
};
