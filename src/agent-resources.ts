import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SettingsManager, type PackageSource } from "@earendil-works/pi-coding-agent";
import { getSettings } from "./settings.js";

export const AGENT_RESOURCES_FOLDER_ID = "joint-bob-agent-resources";
export const AGENT_RESOURCES_FOLDER_LABEL = "Joint Bob agent resources";

export interface AgentResourcePaths {
  root: string;
  sharedSkills: string;
  commonInstructions: string;
  piInstructions: string;
  claudeInstructions: string;
  piExtensions: string;
  piPrompts: string;
  piThemes: string;
  piPackages: string;
  claudeCommands: string;
  claudeAgents: string;
  claudePlugins: string;
  mcpConfig: string;
  commonInstructionsFile: string;
}

export interface AgentResourceReconcileOptions {
  root?: string;
  piConfigPath?: string;
  claudeConfigPath?: string;
  agentsConfigPath?: string;
  dataDir?: string;
}

export interface AgentResourceConflict {
  source: string;
  destination: string;
}

export interface AgentResourceReconcileResult {
  root: string;
  imported: number;
  linked: number;
  unchanged: number;
  conflicts: AgentResourceConflict[];
}

interface Counts {
  imported: number;
  linked: number;
  unchanged: number;
  conflicts: AgentResourceConflict[];
}

interface Mapping {
  source: string;
  destination: string;
  directory: boolean;
  link: boolean;
}

let defaultReconciliation: Promise<AgentResourceReconcileResult> | undefined;

export function agentResourcesRoot(homePath = getSettings().projects.homePath): string {
  return path.join(path.resolve(homePath), ".agent-resources");
}

export function agentResourcePaths(root = agentResourcesRoot()): AgentResourcePaths {
  const resolved = path.resolve(root);
  return {
    root: resolved,
    sharedSkills: path.join(resolved, "shared/skills"),
    commonInstructions: path.join(resolved, "shared/instructions/common"),
    piInstructions: path.join(resolved, "shared/instructions/pi"),
    claudeInstructions: path.join(resolved, "shared/instructions/claude"),
    piExtensions: path.join(resolved, "pi/extensions"),
    piPrompts: path.join(resolved, "pi/prompts"),
    piThemes: path.join(resolved, "pi/themes"),
    piPackages: path.join(resolved, "pi/packages.json"),
    claudeCommands: path.join(resolved, "claude/commands"),
    claudeAgents: path.join(resolved, "claude/agents"),
    claudePlugins: path.join(resolved, "claude/plugins"),
    mcpConfig: path.join(resolved, "mcp/config.json"),
    commonInstructionsFile: path.join(resolved, "runtime/common-instructions.md"),
  };
}

function dataDirectory(configured?: string): string {
  return configured ?? process.env.JOINT_BOB_DATA_DIR ?? process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob");
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function safeName(name: string): boolean {
  return name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") && name === path.basename(name);
}

function excluded(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep);
  const name = normalized.at(-1) ?? "";
  const excludedDirectories = [".git", "node_modules", "logs", "cache", "caches", "dist", "build", "coverage", ".pytest_cache", "__pycache__"];
  return excludedDirectories.some((directory) => normalized.includes(directory))
    || name === ".env"
    || name.startsWith(".env.")
    || [".npmrc", ".pypirc", ".netrc", "credentials.json"].includes(name)
    || /^service-account.*\.json$/i.test(name)
    || /^id_(rsa|ed25519|ecdsa)/.test(name)
    || /\.(pem|key|p12|pfx)$/i.test(name)
    || name.endsWith(".log")
    || name.includes(".sync-conflict-");
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, filePath);
}

async function resolveSource(source: string): Promise<string | undefined> {
  try {
    return await realpath(source);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

async function entries(directory: string): Promise<string[]> {
  const resolved = await resolveSource(directory);
  if (!resolved) return [];
  const found = await readdir(resolved, { withFileTypes: true });
  return found.map((entry) => entry.name).filter(safeName).filter((name) => !excluded(name)).sort();
}

async function digest(source: string): Promise<string> {
  const stats = await lstat(source);
  if (!stats.isDirectory()) return createHash("sha256").update(await readFile(source)).digest("hex");

  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const name of await entries(directory)) {
      const child = path.join(directory, name);
      if ((await lstat(child)).isDirectory()) await visit(child);
      else files.push(child);
    }
  }

  await visit(source);
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    hash.update(`${path.relative(source, file)}\0`);
    hash.update(await readFile(file));
  }
  return hash.digest("hex");
}

async function same(left: string, right: string): Promise<boolean> {
  return await digest(left) === await digest(right);
}

async function canonicalLink(source: string, destination: string): Promise<boolean> {
  try {
    return path.resolve(await realpath(source)) === path.resolve(destination);
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

async function backupAndLink(source: string, destination: string, dataDir: string): Promise<void> {
  const backup = path.join(dataDir, "agent-resources-backups", `${Date.now()}-${randomUUID()}`, path.basename(source));
  await mkdir(path.dirname(backup), { recursive: true });
  await rename(source, backup);
  const target = (await lstat(destination)).isDirectory() ? "dir" : "file";
  await symlink(destination, source, target);
}

async function copyEntry(source: string, destination: string): Promise<void> {
  const staged = `${destination}.${randomUUID()}.staging`;
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await cp(source, staged, {
      recursive: true,
      dereference: true,
      filter: (candidate) => !excluded(path.relative(source, candidate)),
    });
    await rename(staged, destination);
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    throw error;
  }
}

async function linkImportedEntry(source: string, destination: string, dataDir: string, counts: Counts): Promise<void> {
  if (await canonicalLink(source, destination)) return;
  await backupAndLink(source, destination, dataDir);
  counts.linked += 1;
}

async function reconcileEntry(source: string, destination: string, dataDir: string, counts: Counts, link: boolean): Promise<void> {
  const actual = await resolveSource(source);
  if (!actual) return;

  try {
    await lstat(destination);
  } catch (error) {
    if (!missing(error)) throw error;
    await copyEntry(actual, destination);
    counts.imported += 1;
    if (link) await linkImportedEntry(source, destination, dataDir, counts);
    return;
  }

  if (!await same(actual, destination)) {
    counts.conflicts.push({ source, destination });
    return;
  }

  counts.unchanged += 1;
  if (link) await linkImportedEntry(source, destination, dataDir, counts);
}

async function materialize(mapping: Mapping, counts: Counts): Promise<void> {
  if (!mapping.directory) {
    try {
      await lstat(mapping.destination);
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    try {
      await lstat(mapping.source);
      return;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    await mkdir(path.dirname(mapping.source), { recursive: true });
    await symlink(mapping.destination, mapping.source, "file");
    counts.linked += 1;
    return;
  }

  const names = await entries(mapping.destination);
  if (!names.length) return;
  await mkdir(mapping.source, { recursive: true });
  for (const name of names) {
    const source = path.join(mapping.source, name);
    const destination = path.join(mapping.destination, name);
    try {
      await lstat(source);
    } catch (error) {
      if (!missing(error)) throw error;
      const target = (await lstat(destination)).isDirectory() ? "dir" : "file";
      await symlink(destination, source, target);
      counts.linked += 1;
    }
  }
}

function mappings(paths: AgentResourcePaths, pi: string, claude: string, agents: string): Mapping[] {
  return [
    { source: path.join(agents, "skills"), destination: paths.sharedSkills, directory: true, link: true },
    { source: path.join(pi, "skills"), destination: paths.sharedSkills, directory: true, link: true },
    { source: path.join(claude, "skills"), destination: paths.sharedSkills, directory: true, link: true },
    { source: path.join(pi, "extensions"), destination: paths.piExtensions, directory: true, link: true },
    { source: path.join(pi, "prompts"), destination: paths.piPrompts, directory: true, link: true },
    { source: path.join(pi, "themes"), destination: paths.piThemes, directory: true, link: true },
    { source: path.join(pi, "AGENTS.md"), destination: path.join(paths.piInstructions, "AGENTS.md"), directory: false, link: true },
    { source: path.join(claude, "commands"), destination: paths.claudeCommands, directory: true, link: true },
    { source: path.join(claude, "agents"), destination: paths.claudeAgents, directory: true, link: true },
    { source: path.join(claude, "rules"), destination: path.join(paths.claudeInstructions, "rules"), directory: true, link: true },
    { source: path.join(claude, "CLAUDE.md"), destination: path.join(paths.claudeInstructions, "CLAUDE.md"), directory: false, link: true },
    { source: path.join(agents, "rules"), destination: path.join(paths.commonInstructions, "rules"), directory: true, link: true },
  ];
}

async function reconcileMappings(list: Mapping[], dataDir: string, counts: Counts): Promise<void> {
  for (const mapping of list) {
    if (mapping.directory) {
      for (const name of await entries(mapping.source)) {
        await reconcileEntry(path.join(mapping.source, name), path.join(mapping.destination, name), dataDir, counts, mapping.link);
      }
    } else {
      await reconcileEntry(mapping.source, mapping.destination, dataDir, counts, mapping.link);
    }
  }
  for (const mapping of list) await materialize(mapping, counts);
}

function portablePackage(value: PackageSource): boolean {
  const source = typeof value === "string" ? value : value.source;
  return !source.startsWith("/")
    && !source.startsWith("./")
    && !source.startsWith("../")
    && !source.startsWith("~")
    && !source.startsWith("file:")
    && !/^[a-zA-Z]:[\\/]/.test(source);
}

function uniquePackages(packages: PackageSource[]): PackageSource[] {
  return [...new Map(packages.map((item) => [JSON.stringify(item), item])).values()];
}

async function readPackages(filePath: string): Promise<PackageSource[]> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as { packages?: PackageSource[] };
    if (!Array.isArray(value.packages)) throw new Error("packages must be an array");
    return value.packages;
  } catch (error) {
    if (missing(error)) return [];
    throw new Error(`Invalid Pi package declarations at ${filePath}: ${(error as Error).message}`);
  }
}

function addPath(values: string[], item: string): string[] {
  return values.includes(item) ? values : [...values, item];
}

async function reconcilePiSettings(paths: AgentResourcePaths, piConfigPath: string): Promise<void> {
  const settings = SettingsManager.create(paths.root, piConfigPath);
  const errors = settings.drainErrors();
  if (errors.length) throw errors[0];

  const canonical = await readPackages(paths.piPackages);
  const localPackages = settings.getPackages();
  const portable = localPackages.filter(portablePackage);
  await atomicWrite(paths.piPackages, `${JSON.stringify({ packages: uniquePackages([...canonical, ...portable]) }, null, 2)}\n`);

  settings.setPackages(uniquePackages([...localPackages, ...canonical]));
  settings.setExtensionPaths(addPath(settings.getExtensionPaths(), paths.piExtensions));
  settings.setSkillPaths(addPath(settings.getSkillPaths(), paths.sharedSkills));
  settings.setPromptTemplatePaths(addPath(settings.getPromptTemplatePaths(), paths.piPrompts));
  settings.setThemePaths(addPath(settings.getThemePaths(), paths.piThemes));
  await settings.flush();
}

function safePluginName(identity: string): string {
  return identity.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

async function jsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON at ${filePath}: ${(error as Error).message}`);
  }
}

async function importPlugins(paths: AgentResourcePaths, claudeConfigPath: string, counts: Counts): Promise<void> {
  const settingsPath = path.join(claudeConfigPath, "settings.json");
  const installedPath = path.join(claudeConfigPath, "plugins/installed_plugins.json");
  if (!await resolveSource(settingsPath) || !await resolveSource(installedPath)) return;

  const settings = await jsonFile(settingsPath) as { enabledPlugins?: Record<string, boolean> };
  const installed = await jsonFile(installedPath) as { plugins?: Record<string, Array<{ scope?: string; installPath?: string }>> };
  for (const identity of Object.keys(settings.enabledPlugins ?? {}).sort()) {
    if (settings.enabledPlugins?.[identity] !== true) continue;
    const record = installed.plugins?.[identity]?.find((item) => item.scope === "user");
    const source = record?.installPath;
    if (!source || !path.isAbsolute(source) || !existsSync(path.join(source, ".claude-plugin/plugin.json"))) continue;

    const destination = path.join(paths.claudePlugins, safePluginName(identity));
    try {
      await lstat(destination);
      if (await same(source, destination)) {
        counts.unchanged += 1;
        continue;
      }
      counts.conflicts.push({ source, destination });
    } catch (error) {
      if (!missing(error)) throw error;
      await copyEntry(source, destination);
      counts.imported += 1;
    }
  }
}

export async function commonAgentInstructionFiles(root?: string): Promise<Array<{ path: string; content: string }>> {
  const base = agentResourcePaths(root).commonInstructions;
  const result: Array<{ path: string; content: string }> = [];

  async function visit(directory: string): Promise<void> {
    for (const name of await entries(directory)) {
      const candidate = path.join(directory, name);
      if ((await lstat(candidate)).isDirectory()) await visit(candidate);
      else if (name.endsWith(".md")) result.push({ path: candidate, content: await readFile(candidate, "utf8") });
    }
  }

  await visit(base);
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

async function generateCommonInstructions(paths: AgentResourcePaths): Promise<void> {
  const files = await commonAgentInstructionFiles(paths.root);
  if (!files.length) {
    try {
      await unlink(paths.commonInstructionsFile);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    return;
  }

  const content = files
    .map((file) => `# ${path.relative(paths.commonInstructions, file.path)}\n\n${file.content.trimEnd()}\n`)
    .join("\n");
  await atomicWrite(paths.commonInstructionsFile, content);
}

export function piAgentResourcePaths(root?: string): { extensions: string[]; skills: string[]; prompts: string[]; themes: string[] } {
  const paths = agentResourcePaths(root);
  return {
    extensions: [paths.piExtensions],
    skills: [paths.sharedSkills],
    prompts: [paths.piPrompts],
    themes: [paths.piThemes],
  };
}

function installedUserPluginNames(): Set<string> {
  const installedPath = path.join(getSettings().claude.configPath, "plugins/installed_plugins.json");
  if (!existsSync(installedPath)) return new Set();

  let installed: { plugins?: Record<string, Array<{ scope?: string }>> };
  try {
    installed = JSON.parse(readFileSync(installedPath, "utf8")) as { plugins?: Record<string, Array<{ scope?: string }>> };
  } catch (error) {
    throw new Error(`Invalid JSON at ${installedPath}: ${(error as Error).message}`);
  }
  return new Set(Object.entries(installed.plugins ?? {})
    .filter(([, records]) => records.some((record) => record.scope === "user"))
    .map(([identity]) => safePluginName(identity)));
}

export function claudeAgentResourceArgs(root?: string): string[] {
  const paths = agentResourcePaths(root);
  const installed = installedUserPluginNames();
  const args: string[] = [];
  if (existsSync(paths.claudePlugins)) {
    for (const name of readdirSync(paths.claudePlugins).sort()) {
      const plugin = path.join(paths.claudePlugins, name);
      if (!installed.has(name) && existsSync(path.join(plugin, ".claude-plugin/plugin.json"))) {
        args.push("--plugin-dir", plugin);
      }
    }
  }
  if (existsSync(paths.mcpConfig)) args.push("--mcp-config", paths.mcpConfig);
  if (existsSync(paths.commonInstructionsFile)) args.push("--append-system-prompt-file", paths.commonInstructionsFile);
  return args;
}

async function reconcile(options: AgentResourceReconcileOptions): Promise<AgentResourceReconcileResult> {
  const settings = getSettings();
  const root = path.resolve(options.root ?? agentResourcesRoot(settings.projects.homePath));
  const paths = agentResourcePaths(root);
  const pi = options.piConfigPath ?? settings.pi.configPath;
  const claude = options.claudeConfigPath ?? settings.claude.configPath;
  const agents = options.agentsConfigPath ?? path.join(os.homedir(), ".agents");
  const directories = [
    paths.sharedSkills,
    paths.commonInstructions,
    paths.piInstructions,
    paths.claudeInstructions,
    paths.piExtensions,
    paths.piPrompts,
    paths.piThemes,
    paths.claudeCommands,
    paths.claudeAgents,
    paths.claudePlugins,
    path.dirname(paths.mcpConfig),
    path.dirname(paths.commonInstructionsFile),
  ];
  await Promise.all(directories.map((directory) => mkdir(directory, { recursive: true })));

  const counts: Counts = { imported: 0, linked: 0, unchanged: 0, conflicts: [] };
  await reconcileMappings(mappings(paths, pi, claude, agents), dataDirectory(options.dataDir), counts);
  await importPlugins(paths, claude, counts);
  await generateCommonInstructions(paths);
  await reconcilePiSettings(paths, pi);
  return { root, ...counts };
}

export async function reconcileAgentResources(options?: AgentResourceReconcileOptions): Promise<AgentResourceReconcileResult> {
  if (options) return reconcile(options);
  if (!defaultReconciliation) {
    defaultReconciliation = reconcile({}).finally(() => {
      defaultReconciliation = undefined;
    });
  }
  return defaultReconciliation;
}
