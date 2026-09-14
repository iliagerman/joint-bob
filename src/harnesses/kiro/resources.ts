import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agentResourcePaths, commonAgentInstructionFiles } from "../../agent-resources.js";
import { browserAgentInstructions } from "../../browser-agent.js";
import { agentCredentialContext } from "../../secrets.js";
import { getScopedResourcePaths, getSettings } from "../../settings.js";
import { builtinCommands, type CommandDiscoveryOptions, type HarnessCommand } from "../../commands.js";
import { defaultSkillRoots, parseResourceFrontmatter, readConfiguredSkillPath, readSkillDirectory, type SkillRoots, type SkillSummary } from "../../skills.js";
import type { HarnessResources } from "../resource-contract.js";
import type { HarnessOpenOptions } from "../runtime.js";
import { configuredRuntime } from "../runtime-configuration.js";

function defaults(home: string) {
  return {
    executable: "kiro-cli",
    configPath: path.join(home, ".kiro"),
    sessionPath: path.join(home, ".kiro/sessions"),
  };
}

async function skillResource(root: string): Promise<string[]> {
  try {
    const info = await stat(root);
    const resolved = await realpath(root);
    if (info.isFile()) return path.basename(root) === "SKILL.md" ? [`skill://${resolved}`] : [];
    if (info.isDirectory()) return [`skill://${resolved}/**/SKILL.md`];
    return [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function mcpServers(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid shared MCP configuration");
  const root = value as Record<string, unknown>;
  const servers = root.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("Invalid shared MCP mcpServers configuration");
  for (const [name, serverValue] of Object.entries(servers)) {
    if (!name || !serverValue || typeof serverValue !== "object" || Array.isArray(serverValue)) {
      throw new Error("Invalid shared MCP server configuration");
    }
    const server = serverValue as Record<string, unknown>;
    const hasCommand = typeof server.command === "string" && server.command.length > 0;
    const hasUrl = typeof server.url === "string" && server.url.length > 0;
    if (hasCommand === hasUrl) throw new Error("Invalid shared MCP server transport");
    if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some((item) => typeof item !== "string"))) {
      throw new Error("Invalid shared MCP server arguments");
    }
    if (server.env !== undefined && (!server.env || typeof server.env !== "object" || Array.isArray(server.env)
      || Object.values(server.env).some((item) => typeof item !== "string"))) {
      throw new Error("Invalid shared MCP server environment");
    }
  }
  return servers as Record<string, unknown>;
}

async function readMcpConfig(file: string): Promise<Record<string, unknown>> {
  try {
    return mcpServers(JSON.parse(await readFile(file, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function listKiroSkills(projectPath: string, roots: SkillRoots): Promise<SkillSummary[]> {
  const userRoot = roots.user?.kiro;
  const sources = await Promise.all([
    ...(userRoot ? [readSkillDirectory(userRoot, "kiro", "user")] : []),
    readSkillDirectory(roots.shared, "kiro", "user"),
    ...(roots.global ?? []).map((root) => readConfiguredSkillPath(root, "kiro", "user")),
    readSkillDirectory(path.join(projectPath, ".agents", "skills"), "kiro", "project"),
    readSkillDirectory(path.join(projectPath, ".kiro", "skills"), "kiro", "project"),
    ...(roots.project ?? []).map((root) => readConfiguredSkillPath(root, "kiro", "project")),
  ]);
  return sources.flat().map((skill) => ({ ...skill, invocation: `Use the ${skill.name} skill. ` }));
}

async function promptCommand(file: string, scope: "user" | "project"): Promise<HarnessCommand | undefined> {
  try {
    const fields = parseResourceFrontmatter(await readFile(file, "utf8"));
    const name = path.basename(file, ".md");
    return { harness: "kiro", name, description: fields.description ?? "", invocation: `/${name} `, kind: "prompt", scope };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

async function promptCommands(root: string, scope: "user" | "project"): Promise<HarnessCommand[]> {
  if (root.endsWith(".md")) { const command = await promptCommand(root, scope); return command ? [command] : []; }
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { const code = (error as NodeJS.ErrnoException).code; if (code === "ENOENT" || code === "ENOTDIR") return []; throw error; }
  return (await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => promptCommand(path.join(root, entry.name), scope)))).filter((item): item is HarnessCommand => Boolean(item));
}

async function listKiroCommands(projectPath: string, options: CommandDiscoveryOptions): Promise<HarnessCommand[]> {
  const defaults = defaultSkillRoots();
  const roots: SkillRoots = { ...defaults, ...options, user: { ...defaults.user, ...options.user }, global: options.resourcePaths?.global.skills ?? options.global ?? [], project: options.resourcePaths?.project.skills ?? options.project ?? [] };
  const config = getSettings().runtimes.kiro.configPath;
  const prompts = await Promise.all([
    promptCommands(path.join(config, "prompts"), "user"),
    ...(options.resourcePaths?.global.prompts ?? []).map((root) => promptCommands(root, "user")),
    promptCommands(path.join(projectPath, ".kiro", "prompts"), "project"),
    ...(options.resourcePaths?.project.prompts ?? []).map((root) => promptCommands(root, "project")),
  ]);
  return [...builtinCommands("kiro"), ...(await listKiroSkills(projectPath, roots)).map((skill): HarnessCommand => ({ harness: "kiro", name: skill.name, description: skill.description, invocation: skill.invocation!, kind: "skill", scope: skill.scope })), ...prompts.flat()];
}

export async function expandKiroPrompt(text: string, cwd: string, projectId?: string): Promise<string> {
  const match = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match || match[1] === "compact") return text;
  const scoped = getScopedResourcePaths(projectId);
  const roots = [
    path.join(getSettings().runtimes.kiro.configPath, "prompts"),
    ...scoped.global.prompts,
    path.join(cwd, ".kiro", "prompts"),
    ...scoped.project.prompts,
  ];
  for (const root of roots.reverse()) {
    const resolved = path.resolve(root);
    const file = root.endsWith(".md")
      ? path.basename(root, ".md") === match[1] ? resolved : undefined
      : path.join(resolved, `${match[1]}.md`);
    if (!file) continue;
    try {
      const template = await readFile(file, "utf8");
      return match[2] ? `${template.trimEnd()}\n\n${match[2]}` : template;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
  }
  return text;
}

const harnessResources: HarnessResources = { skills: listKiroSkills, commands: listKiroCommands };
export default harnessResources;

export const kiroToolCategories = ["read", "write", "shell", "web", "subagent"];

export async function kiroAgentProfile(options: HarnessOpenOptions, credentialContext?: string, enabledTools?: string[]): Promise<string> {
  if (!/^[a-zA-Z0-9_-]+$/.test(options.sessionId)) throw new Error("Kiro profile session ID must be safe");
  if (enabledTools !== undefined && (!Array.isArray(enabledTools) || enabledTools.some((name) => typeof name !== "string" || !kiroToolCategories.includes(name)))) {
    throw new Error("Unknown Kiro tool");
  }
  const runtime = configuredRuntime("kiro", defaults(os.homedir()));
  const name = `joint-bob-${options.sessionId}`;
  const agents = path.join(runtime.configPath, "agents");
  await mkdir(agents, { recursive: true, mode: 0o700 });
  const agentsInfo = await lstat(agents);
  if (agentsInfo.isSymbolicLink() || !agentsInfo.isDirectory()) throw new Error("Kiro agents path must be a real directory");
  const relativeAgents = path.relative(path.resolve(runtime.configPath), path.resolve(agents));
  if (relativeAgents.startsWith("..") || path.isAbsolute(relativeAgents)) throw new Error("Kiro agents path is outside KIRO_HOME");
  const scoped = getScopedResourcePaths(options.projectId);
  const instructions = await commonAgentInstructionFiles(undefined, [...scoped.global.rules, ...scoped.project.rules]);
  const resources = agentResourcePaths();
  const skillRoots = [
    resources.sharedSkills,
    ...scoped.global.skills,
    ...scoped.project.skills,
    path.join(options.cwd, ".agents/skills"),
    path.join(options.cwd, ".kiro/skills"),
  ];
  const skills = [...new Set((await Promise.all(skillRoots.map(skillResource))).flat())];
  const agentsFile = path.join(options.cwd, "AGENTS.md");
  try {
    if ((await lstat(agentsFile)).isFile()) skills.push(`file://${agentsFile}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const prompt = [
    ...instructions.map((item) => item.content),
    browserAgentInstructions,
    credentialContext ?? agentCredentialContext(options.projectId, { engine: "kiro", sessionId: options.sessionId }),
  ].filter(Boolean).join("\n\n");
  const profile = {
    name,
    description: "Joint Bob Kiro session profile",
    prompt,
    resources: skills,
    tools: enabledTools === undefined ? ["*"] : [...enabledTools],
    allowedTools: [],
    mcpServers: await readMcpConfig(resources.mcpConfig),
    includeMcpJson: true,
  };
  const file = path.join(agents, `${name}.json`);
  const temporary = path.join(agents, `.${name}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
  return name;
}
