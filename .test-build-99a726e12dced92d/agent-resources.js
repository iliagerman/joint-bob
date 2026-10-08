import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadSkills, SettingsManager } from "@earendil-works/pi-coding-agent";
import { resolveDataDirectory } from "./data-directory.js";
import { allowSkillImport, receivedOwner, skillSuppressed, withSkillMutation } from "./skill-sharing-files.js";
import { getSettings } from "./settings.js";
const AGENT_RESOURCES_FOLDER_ID = "joint-bob-agent-resources";
const AGENT_RESOURCES_FOLDER_LABEL = "Joint Bob agent resources";
const CLAUDE_RESOURCE_PLUGIN_NAME = "joint-bob-resources";
let defaultReconciliation;
function agentResourcesRoot(homePath = getSettings().projects.homePath) {
  return path.join(path.resolve(homePath), ".agent-resources");
}
function agentResourcePaths(root = agentResourcesRoot()) {
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
    commonInstructionsFile: path.join(resolved, "runtime/common-instructions.md")
  };
}
function dataDirectory(configured) {
  return resolveDataDirectory(configured);
}
function missing(error) {
  return error.code === "ENOENT";
}
function safeName(name) {
  return name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") && name === path.basename(name);
}
function skillName(source, manifest) {
  const loaded = loadSkills({ cwd: source, agentDir: source, skillPaths: [manifest], includeDefaults: false });
  const skill = loaded.skills[0];
  if (loaded.skills.length !== 1 || typeof skill.description !== "string" || !skill.description.trim()) {
    throw new Error(`Invalid skill metadata at ${manifest}`);
  }
  if (!safeName(skill.name) || skill.name.startsWith(".")) throw new Error(`Invalid skill metadata at ${manifest}: unsafe name`);
  return skill.name;
}
async function validateSkillTree(source, relative = "") {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const childRelative = path.join(relative, entry.name);
    if (excluded(childRelative)) continue;
    const child = path.join(source, entry.name);
    const info = await lstat(child);
    if (info.isSymbolicLink()) throw new Error(`Nested symbolic link is not allowed: ${child}`);
    if (info.isDirectory()) await validateSkillTree(child, childRelative);
    else if (!info.isFile()) throw new Error(`Unsupported file type in skill: ${child}`);
  }
}
async function discoverLocalSkills(roots) {
  const found = /* @__PURE__ */ new Map();
  const realSources = /* @__PURE__ */ new Set();
  for (const root of roots) {
    const resolvedInput = await realpath(root);
    const info = await lstat(resolvedInput);
    if (info.isFile() && path.basename(resolvedInput) !== "SKILL.md") throw new Error(`Skill file must be named SKILL.md: ${root}`);
    const candidates = info.isFile() ? [path.dirname(resolvedInput)] : existsSync(path.join(resolvedInput, "SKILL.md")) ? [resolvedInput] : (await readdir(resolvedInput, { withFileTypes: true })).filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => path.join(resolvedInput, entry.name));
    for (const candidate of candidates) {
      const source = await realpath(candidate);
      const manifest = path.join(source, "SKILL.md");
      if (!existsSync(manifest)) continue;
      const name = skillName(source, manifest);
      if (realSources.has(source)) continue;
      const previous = found.get(name);
      if (previous && previous.source !== source) throw new Error(`Conflicting skill name ${name}: ${previous.source} and ${source}`);
      await validateSkillTree(source);
      found.set(name, { name, source });
      realSources.add(source);
    }
  }
  if (!found.size) throw new Error("No valid SKILL.md skills found");
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name));
}
function overlaps(left, right) {
  const relative = path.relative(left, right);
  return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
}
async function destinationExists(destination) {
  try {
    await lstat(destination);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
async function replacePublishedSkill(staged, destination, backup) {
  if (backup) {
    await mkdir(path.dirname(backup), { recursive: true });
    await cp(destination, backup, { recursive: true });
  }
  await rm(destination, { recursive: true, force: true });
  try {
    await rename(staged, destination);
  } catch (error) {
    if (backup) await cp(backup, destination, { recursive: true });
    throw error;
  }
}
function syncLocalSkills(roots, options = {}) {
  return withSkillMutation(() => publishLocalSkills(roots, options));
}
async function publishLocalSkills(roots, options) {
  if (!roots.length || roots.length > 20) throw new Error("Skill paths must contain between 1 and 20 entries");
  if (roots.some((root) => !path.isAbsolute(root))) throw new Error("Skill paths must be absolute");
  const skills = await discoverLocalSkills(roots);
  const paths = agentResourcePaths(options.root);
  const operation = randomUUID();
  const stagingRoot = path.join(paths.root, "cache/skill-sync", operation);
  const backupRoot = path.join(dataDirectory(options.dataDir), "agent-resources-backups", operation);
  const published = [], unchanged = [];
  const stagedSkills = [];
  try {
    for (const skill of skills) {
      if (await receivedOwner(paths.sharedSkills, skill.name, options.dataDir)) throw new Error("Received skills cannot be overwritten by import");
      const destination = path.join(paths.sharedSkills, skill.name);
      if (overlaps(skill.source, destination) || overlaps(destination, skill.source)) {
        if (path.resolve(skill.source) === path.resolve(destination)) {
          unchanged.push(skill.name);
          continue;
        }
        throw new Error(`Skill source and destination overlap: ${skill.source}`);
      }
      if (await destinationExists(destination) && (await lstat(destination)).isSymbolicLink()) throw new Error(`Skill destination is a symbolic link: ${destination}`);
      const staged = path.join(stagingRoot, skill.name);
      await mkdir(path.dirname(staged), { recursive: true });
      await cp(skill.source, staged, { recursive: true, filter: (candidate) => !excluded(path.relative(skill.source, candidate)) });
      stagedSkills.push({ name: skill.name, source: staged });
    }
    for (const staged of stagedSkills) {
      const destination = path.join(paths.sharedSkills, staged.name);
      if (await destinationExists(destination) && await samePublished(staged.source, destination)) {
        unchanged.push(staged.name);
        continue;
      }
      const backup = await destinationExists(destination) ? path.join(backupRoot, staged.name) : null;
      await mkdir(paths.sharedSkills, { recursive: true });
      await replacePublishedSkill(staged.source, destination, backup);
      published.push(staged.name);
    }
    for (const name of [...published, ...unchanged]) await allowSkillImport(paths.sharedSkills, name, options.dataDir);
    return { published, unchanged, backupPath: published.some((name) => existsSync(path.join(backupRoot, name))) ? backupRoot : null };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}
function excluded(relativePath) {
  const normalized = relativePath.split(path.sep);
  const name = normalized.at(-1) ?? "";
  const excludedDirectories = [".git", "node_modules", "logs", "cache", "caches", "dist", "build", "coverage", ".pytest_cache", "__pycache__"];
  return excludedDirectories.some((directory) => normalized.includes(directory)) || name === ".env" || name.startsWith(".env.") || [".npmrc", ".pypirc", ".netrc", "credentials.json"].includes(name) || /^service-account.*\.json$/i.test(name) || /^id_(rsa|ed25519|ecdsa)/.test(name) || /\.(pem|key|p12|pfx)$/i.test(name) || name.endsWith(".log") || name.includes(".sync-conflict-");
}
async function atomicWrite(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, filePath);
}
async function resolveSource(source) {
  try {
    return await realpath(source);
  } catch (error) {
    if (missing(error)) return void 0;
    throw error;
  }
}
async function entries(directory) {
  const resolved = await resolveSource(directory);
  if (!resolved) return [];
  const found = await readdir(resolved, { withFileTypes: true });
  return found.map((entry) => entry.name).filter(safeName).filter((name) => !excluded(name)).sort();
}
async function digest(source) {
  const stats = await lstat(source);
  if (!stats.isDirectory()) return createHash("sha256").update(await readFile(source)).digest("hex");
  const files = [];
  async function visit(directory) {
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
async function same(left, right) {
  return await digest(left) === await digest(right);
}
async function publishDigest(source) {
  const files = [];
  async function visit(entry) {
    const info = await lstat(entry);
    if (info.isDirectory()) {
      for (const name of await entries(entry)) await visit(path.join(entry, name));
    } else files.push(entry);
  }
  await visit(source);
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    const info = await lstat(file);
    hash.update(`${path.relative(source, file)}\0${info.mode & 73}\0`);
    hash.update(await readFile(file));
  }
  return hash.digest("hex");
}
async function samePublished(left, right) {
  return await publishDigest(left) === await publishDigest(right);
}
async function publishableDigest(source) {
  const files = [];
  async function visit(entry) {
    if (excluded(path.relative(source, entry))) return;
    if ((await lstat(entry)).isDirectory()) {
      for (const name of await entries(entry)) await visit(path.join(entry, name));
    } else files.push(entry);
  }
  await visit(source);
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    hash.update(`${path.relative(source, file)}\0${(await lstat(file)).mode & 73}\0`);
    hash.update(await readFile(file));
  }
  return hash.digest("hex");
}
async function scanLocalSkills(root, options = {}) {
  if (!path.isAbsolute(root)) throw new Error("Skill paths must be absolute");
  const resolvedRoot = await realpath(root);
  const shared = agentResourcePaths(options.root).sharedSkills;
  const directories = existsSync(path.join(resolvedRoot, "SKILL.md")) ? [root] : (await readdir(resolvedRoot, { withFileTypes: true })).filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith(".")).map((entry) => path.join(root, entry.name));
  const candidates = [];
  for (const directory of directories) {
    let source;
    try {
      source = await realpath(directory);
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    const manifest = path.join(source, "SKILL.md");
    if (!existsSync(manifest)) continue;
    let name = path.basename(directory), description = "";
    try {
      name = skillName(source, manifest);
      description = loadSkills({ cwd: source, agentDir: source, skillPaths: [manifest], includeDefaults: false }).skills[0]?.description ?? "";
      await validateSkillTree(source);
    } catch (error) {
      candidates.push({ name, description, path: directory, status: "new", error: error.message });
      continue;
    }
    const destination = path.join(shared, name);
    let status = "new";
    const exists = await destinationExists(destination);
    if (exists && source === await realpath(destination)) status = "linked";
    else if (exists) status = await publishableDigest(source) === await publishableDigest(destination) ? "installed" : "changed";
    candidates.push({ name, description, path: directory, status });
  }
  return candidates.sort((left, right) => left.name.localeCompare(right.name));
}
async function canonicalLink(source, destination) {
  try {
    return path.resolve(await realpath(source)) === path.resolve(destination);
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
async function backupAndLink(source, destination, dataDir) {
  const backup = path.join(dataDir, "agent-resources-backups", `${Date.now()}-${randomUUID()}`, path.basename(source));
  await mkdir(path.dirname(backup), { recursive: true });
  await rename(source, backup);
  const target = (await lstat(destination)).isDirectory() ? "dir" : "file";
  await symlink(destination, source, target);
}
async function copyEntry(source, destination) {
  const staged = `${destination}.${randomUUID()}.staging`;
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await cp(source, staged, {
      recursive: true,
      dereference: true,
      filter: (candidate) => !excluded(path.relative(source, candidate))
    });
    await rename(staged, destination);
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    throw error;
  }
}
async function linkImportedEntry(source, destination, dataDir, counts) {
  if (await canonicalLink(source, destination)) return;
  await backupAndLink(source, destination, dataDir);
  counts.linked += 1;
}
async function reconcileEntry(source, destination, dataDir, counts, link) {
  const actual = await resolveSource(source);
  if (!actual) return;
  if (actual === await resolveSource(destination)) {
    counts.unchanged += 1;
    return;
  }
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
async function materialize(mapping, counts, dataDir) {
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
    if (path.basename(mapping.source) === "skills" && await skillSuppressed(mapping.destination, name, dataDir)) continue;
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
function mappings(paths, pi, claude, agents) {
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
    { source: path.join(agents, "rules"), destination: path.join(paths.commonInstructions, "rules"), directory: true, link: true }
  ];
}
async function reconcileMappings(list, dataDir, counts) {
  for (const mapping of list) {
    if (mapping.directory) {
      for (const name of await entries(mapping.source)) {
        if (path.basename(mapping.source) === "skills" && (await skillSuppressed(mapping.destination, name, dataDir) || await receivedOwner(mapping.destination, name, dataDir))) continue;
        await reconcileEntry(path.join(mapping.source, name), path.join(mapping.destination, name), dataDir, counts, mapping.link);
      }
    } else {
      await reconcileEntry(mapping.source, mapping.destination, dataDir, counts, mapping.link);
    }
  }
  for (const mapping of list) await materialize(mapping, counts, dataDir);
}
function portablePackage(value) {
  const source = typeof value === "string" ? value : value.source;
  return !source.startsWith("/") && !source.startsWith("./") && !source.startsWith("../") && !source.startsWith("~") && !source.startsWith("file:") && !/^[a-zA-Z]:[\\/]/.test(source);
}
function uniquePackages(packages) {
  return [...new Map(packages.map((item) => [JSON.stringify(item), item])).values()];
}
async function readPackages(filePath) {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8"));
    if (!Array.isArray(value.packages)) throw new Error("packages must be an array");
    return value.packages;
  } catch (error) {
    if (missing(error)) return [];
    throw new Error(`Invalid Pi package declarations at ${filePath}: ${error.message}`);
  }
}
function addPath(values, item) {
  return values.includes(item) ? values : [...values, item];
}
async function reconcilePiSettings(paths, piConfigPath) {
  const settings = SettingsManager.create(paths.root, piConfigPath);
  const errors = settings.drainErrors();
  if (errors.length) throw errors[0];
  const canonical = await readPackages(paths.piPackages);
  const localPackages = settings.getPackages();
  const portable = localPackages.filter(portablePackage);
  await atomicWrite(paths.piPackages, `${JSON.stringify({ packages: uniquePackages([...canonical, ...portable]) }, null, 2)}
`);
  settings.setPackages(uniquePackages([...localPackages, ...canonical]));
  settings.setExtensionPaths(addPath(settings.getExtensionPaths(), paths.piExtensions));
  settings.setSkillPaths(addPath(settings.getSkillPaths(), paths.sharedSkills));
  settings.setPromptTemplatePaths(addPath(settings.getPromptTemplatePaths(), paths.piPrompts));
  settings.setThemePaths(addPath(settings.getThemePaths(), paths.piThemes));
  await settings.flush();
}
function safePluginName(identity) {
  return identity.replace(/[^a-zA-Z0-9._-]+/g, "_");
}
async function jsonFile(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON at ${filePath}: ${error.message}`);
  }
}
async function importPlugins(paths, claudeConfigPath, counts) {
  const settingsPath = path.join(claudeConfigPath, "settings.json");
  const installedPath = path.join(claudeConfigPath, "plugins/installed_plugins.json");
  if (!await resolveSource(settingsPath) || !await resolveSource(installedPath)) return;
  const settings = await jsonFile(settingsPath);
  const installed = await jsonFile(installedPath);
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
async function commonAgentInstructionFiles(root, additionalPaths = []) {
  const result = [];
  async function visit(source) {
    let info;
    try {
      info = await lstat(source);
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    if (info.isDirectory()) {
      for (const name of await entries(source)) await visit(path.join(source, name));
    } else if (source.endsWith(".md")) result.push({ path: source, content: await readFile(source, "utf8") });
  }
  await visit(agentResourcePaths(root).commonInstructions);
  for (const source of additionalPaths) await visit(source);
  return result.sort((left, right) => left.path.localeCompare(right.path));
}
async function generateCommonInstructions(paths) {
  const files = await commonAgentInstructionFiles(paths.root);
  if (!files.length) {
    try {
      await unlink(paths.commonInstructionsFile);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    return;
  }
  const content = files.map((file) => `# ${path.relative(paths.commonInstructions, file.path)}

${file.content.trimEnd()}
`).join("\n");
  await atomicWrite(paths.commonInstructionsFile, content);
}
function configuredPaths(configured, type) {
  return configured ? [.../* @__PURE__ */ new Set([...configured.global[type], ...configured.project[type]])] : [];
}
function piAgentResourcePaths(root, configured) {
  const paths = agentResourcePaths(root);
  return {
    extensions: [.../* @__PURE__ */ new Set([paths.piExtensions, ...configuredPaths(configured, "plugins")])],
    skills: [.../* @__PURE__ */ new Set([paths.sharedSkills, ...configuredPaths(configured, "skills")])],
    prompts: [.../* @__PURE__ */ new Set([paths.piPrompts, ...configuredPaths(configured, "prompts")])],
    themes: [paths.piThemes]
  };
}
function installedUserPluginNames() {
  const installedPath = path.join(getSettings().claude.configPath, "plugins/installed_plugins.json");
  if (!existsSync(installedPath)) return /* @__PURE__ */ new Set();
  let installed;
  try {
    installed = JSON.parse(readFileSync(installedPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON at ${installedPath}: ${error.message}`);
  }
  return new Set(Object.entries(installed.plugins ?? {}).filter(([, records]) => records.some((record) => record.scope === "user")).map(([identity]) => safePluginName(identity)));
}
function claudePluginSources(sources) {
  const plugins = [];
  for (const source of sources) {
    if (!existsSync(source)) continue;
    if (source.endsWith(".zip") || existsSync(path.join(source, ".claude-plugin/plugin.json"))) plugins.push(source);
    else if (lstatSync(source).isDirectory()) {
      for (const name of readdirSync(source).sort()) {
        const child = path.join(source, name);
        if (child.endsWith(".zip") || existsSync(path.join(child, ".claude-plugin/plugin.json"))) plugins.push(child);
      }
    }
  }
  return [...new Set(plugins)];
}
function resourceEntries(roots, kind) {
  const found = /* @__PURE__ */ new Map();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    if (kind === "skills" && existsSync(path.join(root, "SKILL.md"))) {
      found.set(path.basename(root), root);
      continue;
    }
    if (kind === "prompts" && root.endsWith(".md") && lstatSync(root).isFile()) {
      found.set(path.basename(root, ".md"), root);
      continue;
    }
    if (!lstatSync(root).isDirectory()) continue;
    for (const name of readdirSync(root).sort()) {
      const source = path.join(root, name);
      if (kind === "skills" && existsSync(path.join(source, "SKILL.md"))) found.set(name, source);
      if (kind === "prompts" && name.endsWith(".md") && lstatSync(source).isFile()) found.set(path.basename(name, ".md"), source);
    }
  }
  return new Map([...found].sort(([left], [right]) => left.localeCompare(right)));
}
function generatedResourcePlugin(paths, configured) {
  let skillPaths = [paths.sharedSkills];
  let promptPaths = [];
  if (configured) {
    skillPaths = [...skillPaths, ...configured.global.skills, ...configured.project.skills];
    promptPaths = [...configured.global.prompts, ...configured.project.prompts];
  }
  const skills = resourceEntries(skillPaths, "skills");
  const prompts = resourceEntries(promptPaths, "prompts");
  if (!skills.size && !prompts.size) return void 0;
  const mappings2 = [...skills, ...prompts].map(([name, source]) => `${name}\0${source}\0${existsSync(source) ? readFileSync(source.endsWith(".md") ? source : path.join(source, "SKILL.md")) : ""}`).join("\n");
  const target = path.join(dataDirectory(), "runtime", "resource-plugins", createHash("sha256").update(mappings2).digest("hex"));
  if (existsSync(target)) return target;
  const temporary = `${target}.${randomUUID()}.tmp`;
  mkdirSync(path.join(temporary, ".claude-plugin"), { recursive: true });
  writeFileSync(path.join(temporary, ".claude-plugin", "plugin.json"), JSON.stringify({ name: CLAUDE_RESOURCE_PLUGIN_NAME }));
  for (const [name, source] of skills) {
    mkdirSync(path.join(temporary, "skills"), { recursive: true });
    symlinkSync(source, path.join(temporary, "skills", name), "dir");
  }
  for (const [name, source] of prompts) {
    mkdirSync(path.join(temporary, "commands"), { recursive: true });
    symlinkSync(source, path.join(temporary, "commands", `${name}.md`), "file");
  }
  mkdirSync(path.dirname(target), { recursive: true });
  try {
    renameSync(temporary, target);
  } catch (error) {
    const code = error.code;
    if (!code || !["EEXIST", "ENOTEMPTY"].includes(code) || !existsSync(target)) throw error;
    rmSync(temporary, { recursive: true, force: true });
  }
  return target;
}
function generatedInstructionFile(paths, configured, extraInstructions) {
  const additional = configuredPaths(configured, "rules");
  if (!additional.length && !extraInstructions) return paths.commonInstructionsFile;
  const files = [];
  const visit = (source) => {
    if (!existsSync(source)) return;
    if (lstatSync(source).isDirectory()) for (const name of readdirSync(source).sort()) visit(path.join(source, name));
    else if (source.endsWith(".md")) files.push(source);
  };
  if (existsSync(paths.commonInstructionsFile)) files.push(paths.commonInstructionsFile);
  for (const source of additional) visit(source);
  const content = [...files.sort().map((file) => readFileSync(file, "utf8")), ...extraInstructions ? [extraInstructions] : []].join("\n");
  const filePath = path.join(dataDirectory(), "runtime", "resource-instructions", `${createHash("sha256").update(content).digest("hex")}.md`);
  if (!existsSync(filePath)) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  return filePath;
}
function claudeAgentResourceArgs(root, configured, extraInstructions) {
  const paths = agentResourcePaths(root);
  const installed = installedUserPluginNames();
  const args = [];
  if (existsSync(paths.claudePlugins)) for (const name of readdirSync(paths.claudePlugins).sort()) {
    const plugin = path.join(paths.claudePlugins, name);
    if (!installed.has(name) && existsSync(path.join(plugin, ".claude-plugin/plugin.json"))) args.push("--plugin-dir", plugin);
  }
  for (const plugin of claudePluginSources(configuredPaths(configured, "plugins"))) args.push("--plugin-dir", plugin);
  const generated = generatedResourcePlugin(paths, configured);
  if (generated) args.push("--plugin-dir", generated);
  if (existsSync(paths.mcpConfig)) args.push("--mcp-config", paths.mcpConfig);
  const instructions = generatedInstructionFile(paths, configured, extraInstructions);
  if (existsSync(instructions)) args.push("--append-system-prompt-file", instructions);
  return args;
}
async function reconcile(options) {
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
    path.dirname(paths.commonInstructionsFile)
  ];
  await Promise.all(directories.map((directory) => mkdir(directory, { recursive: true })));
  const counts = { imported: 0, linked: 0, unchanged: 0, conflicts: [] };
  await reconcileMappings(mappings(paths, pi, claude, agents), dataDirectory(options.dataDir), counts);
  await importPlugins(paths, claude, counts);
  await generateCommonInstructions(paths);
  await reconcilePiSettings(paths, pi);
  return { root, ...counts };
}
async function reconcileAgentResources(options) {
  if (options) return withSkillMutation(() => reconcile(options));
  if (!defaultReconciliation) {
    defaultReconciliation = withSkillMutation(() => reconcile({})).finally(() => {
      defaultReconciliation = void 0;
    });
  }
  return defaultReconciliation;
}
export {
  AGENT_RESOURCES_FOLDER_ID,
  AGENT_RESOURCES_FOLDER_LABEL,
  CLAUDE_RESOURCE_PLUGIN_NAME,
  agentResourcePaths,
  agentResourcesRoot,
  claudeAgentResourceArgs,
  commonAgentInstructionFiles,
  piAgentResourcePaths,
  reconcileAgentResources,
  scanLocalSkills,
  syncLocalSkills
};
