import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { agentResourcePaths, syncLocalSkills } from "./agent-resources.js";
import { resolveDataDirectory } from "./data-directory.js";
import { getSettings } from "./settings.js";
import { backupRemovedSkill, markReceived, receivedOwner, skillSuppressed, unlinkSkillAliases, unmarkReceived } from "./skill-sharing-files.js";
import { validateSkillName } from "./skill-sharing.js";
import { markReceivedResource } from "./resource-activation.js";
import { parseResourceFrontmatter } from "./skills.js";
import { gitlabGitEnvironment } from "./secrets.js";

/*
 * Git repositories as a source of skills, Claude plugins and MCP servers.
 *
 * A repository is cloned once into this node's data folder. Its contents are listed, and the
 * items picked from it are copied where every agent here loads them: skills into managed
 * skills, plugins into the managed Claude plugins folder, MCP servers into the managed MCP
 * configuration. The clone stays, so a later update fetches the new commit and copies the
 * picked items again. A node that received a repository from its owner keeps the owner's
 * commit and selection instead of choosing its own.
 */

const exec = promisify(execFile);

export type GitItemKind = "skill" | "plugin" | "mcp";

export interface GitResourceItem {
  /** Stable within a repository: the kind, the item's path, and for MCP the server name. */
  key: string;
  kind: GitItemKind;
  name: string;
  description: string;
  path: string;
  /** The plugin folder a skill sits in, when it has one. */
  plugin?: string;
  error?: string;
}

export interface InstalledGitItem { key: string; kind: GitItemKind; name: string; sourceDigest: string; installedDigest: string }

export interface GitDelivery { commit: string | null; error: string | null; at: string }

export interface GitResourceSource {
  id: string;
  url: string;
  ref: string | null;
  /** Local-only secret account reference; never included in repository offers to other nodes. */
  gitlabAccountId?: string;
  commit: string;
  /** Set on a repository another node shares with this one; it follows that node's commit and selection. */
  ownerNodeId: string | null;
  autoUpdate: boolean;
  /** Nodes this node shares the repository with. */
  recipients: string[];
  deliveries: Record<string, GitDelivery>;
  latestCommit: string | null;
  checkedAt: string | null;
  checkError: string | null;
  installed: InstalledGitItem[];
  lastError: string | null;
  addedAt: string;
  updatedAt: string;
}

export type GitItemStatus = "available" | "imported" | "edited" | "removed" | "gone";
export interface GitItemView extends GitResourceItem { status: GitItemStatus }
export interface GitSourceView extends Omit<GitResourceSource, "gitlabAccountId"> { usesGitLabCredential: boolean; label: string; updateAvailable: boolean; items: GitItemView[] }

export interface GitApplyResult { installed: string[]; unchanged: string[]; removed: string[]; kept: string[]; errors: string[]; backups: string[]; skillsChanged: boolean }

export interface GitResourceOptions { dataDir?: string; root?: string }

interface Store { version: 1; sources: GitResourceSource[] }

const MAX_SCAN_DIRECTORIES = 5_000;
const MAX_SCAN_DEPTH = 8;
const MAX_PLUGIN_BYTES = 50 * 1024 * 1024;
const MAX_PLUGIN_FILES = 5_000;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage", "__pycache__", ".pytest_cache", ".venv", "venv", "cache", "caches", "logs"]);
const refPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const commitPattern = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export class GitResourceError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/* ---- Paths and the store ---- */

function root(options: GitResourceOptions): string { return path.join(resolveDataDirectory(options.dataDir), "git-resources"); }
function storeFile(options: GitResourceOptions): string { return path.join(root(options), "sources.json"); }
function checkoutOf(source: Pick<GitResourceSource, "id" | "ownerNodeId">, options: GitResourceOptions): string {
  return path.join(root(options), "checkouts", source.ownerNodeId ? `${source.ownerNodeId}-${source.id}` : source.id);
}

let pending: Promise<unknown> = Promise.resolve();
/** Every change to the store, the clones and what they installed runs one at a time. */
export function withGitResourceMutation<T>(action: () => Promise<T>): Promise<T> {
  const result = pending.then(action);
  pending = result.then(() => undefined, () => undefined);
  return result;
}

async function readStore(options: GitResourceOptions): Promise<Store> {
  try {
    const value = JSON.parse(await readFile(storeFile(options), "utf8")) as Partial<Store>;
    return { version: 1, sources: Array.isArray(value.sources) ? value.sources.map((source) => ({ ...source, deliveries: source.deliveries ?? {}, recipients: source.recipients ?? [] })) : [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, sources: [] };
    throw error;
  }
}

async function writeStore(store: Store, options: GitResourceOptions): Promise<void> {
  const file = storeFile(options);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

export async function listGitSourceRecords(options: GitResourceOptions = {}): Promise<GitResourceSource[]> {
  return (await readStore(options)).sources;
}

function findSource(store: Store, id: string, ownerNodeId: string | null = null): GitResourceSource {
  const source = store.sources.find((item) => item.id === id && item.ownerNodeId === ownerNodeId);
  if (!source) throw new GitResourceError("Repository not found", 404);
  return source;
}

/* ---- Git ---- */

/** Accepts https, ssh, scp-style and file URLs, or GitHub's owner/repo shorthand. Credentials never go in the URL. */
export function normalizeGitUrl(input: string): string {
  const url = input.trim();
  if (!url || url.length > 2048 || url.startsWith("-") || /[\s\0]/.test(url)) throw new GitResourceError("Enter a git repository URL");
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url) && !url.startsWith(".")) return `https://github.com/${url.replace(/\.git$/, "")}.git`;
  if (/^[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+:[A-Za-z0-9_./~-]+$/.test(url)) return url;
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new GitResourceError("Enter a git repository URL"); }
  if (!["https:", "ssh:", "file:"].includes(parsed.protocol)) throw new GitResourceError("Use an https, ssh or file repository URL");
  if (parsed.password || (parsed.protocol === "https:" && parsed.username)) throw new GitResourceError("Remove the credentials from the URL; git uses this node's own credentials");
  return url;
}

export function normalizeGitRef(input: string | null | undefined): string | null {
  const ref = input?.trim();
  if (!ref) return null;
  if (!refPattern.test(ref) || ref.includes("..") || ref.endsWith(".lock") || ref.endsWith("/")) throw new GitResourceError("Enter a branch or tag name");
  return ref;
}

/** A repository's own hooks, filters and helper protocols never run here. */
async function git(args: string[], cwd?: string, timeout = 180_000, credentials?: NodeJS.ProcessEnv): Promise<string> {
  const environment: NodeJS.ProcessEnv = { ...process.env, ...credentials, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" };
  if (credentials?.GITLAB_TOKEN) {
    delete environment.GH_TOKEN;
    delete environment.GITHUB_TOKEN;
    delete environment.PI_GITHUB_TOKEN;
  }
  try {
    const { stdout } = await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never", "-c", "core.fsmonitor=false", ...args], {
      cwd, timeout, maxBuffer: 16 * 1024 * 1024, env: environment,
    });
    return stdout.trim();
  } catch (error) {
    const detail = String((error as { stderr?: string }).stderr ?? (error as Error).message).trim().split("\n").filter(Boolean).at(-1);
    throw new GitResourceError(`git ${args[0]} failed${detail ? `: ${detail}` : ""}`, 502);
  }
}

async function headCommit(checkout: string): Promise<string> { return git(["rev-parse", "HEAD"], checkout); }

async function cloneInto(checkout: string, url: string, ref: string | null, credentials?: NodeJS.ProcessEnv): Promise<string> {
  await rm(checkout, { recursive: true, force: true });
  await mkdir(path.dirname(checkout), { recursive: true });
  try {
    await git(["clone", "--depth", "1", "--no-tags", "--single-branch", ...(ref ? ["--branch", ref] : []), "--", url, checkout], undefined, 180_000, credentials);
    return await headCommit(checkout);
  } catch (error) { await rm(checkout, { recursive: true, force: true }); throw error; }
}

/** Moves a clone to a commit: the tip of its ref, or an exact commit a sharing node chose. */
async function checkoutCommit(checkout: string, url: string, ref: string | null, commit?: string, credentials?: NodeJS.ProcessEnv): Promise<string> {
  try { await lstat(path.join(checkout, ".git")); }
  catch { await cloneInto(checkout, url, ref, credentials); }
  if (commit && await headCommit(checkout).catch(() => "") === commit) return commit;
  try { await git(["fetch", "--depth", "1", "--no-tags", "origin", commit ?? ref ?? "HEAD"], checkout, 180_000, credentials); }
  catch (error) {
    if (!commit) throw error;
    // A server that refuses to send one commit by name sends the branch's history instead.
    const shallow = await exists(path.join(checkout, ".git/shallow"));
    await git(["fetch", "--no-tags", ...(shallow ? ["--unshallow"] : []), "origin", ref ?? "HEAD"], checkout, 180_000, credentials);
  }
  await git(["checkout", "--quiet", "--detach", "--force", commit ?? "FETCH_HEAD"], checkout);
  await git(["clean", "-ffdxq"], checkout);
  return headCommit(checkout);
}

/** The commit the ref points at on the remote now, without fetching anything. */
export async function remoteCommit(url: string, ref: string | null, credentials?: NodeJS.ProcessEnv): Promise<string> {
  if (ref && commitPattern.test(ref)) return ref;
  const output = await git(["ls-remote", "--", url, ...(ref ? [ref] : ["HEAD"])], undefined, 180_000, credentials);
  const lines = output.split("\n").map((line) => line.split("\t")).filter((parts) => parts.length === 2 && commitPattern.test(parts[0]));
  const wanted = ref ? [`refs/heads/${ref}`, `refs/tags/${ref}^{}`, `refs/tags/${ref}`, ref] : ["HEAD"];
  for (const name of wanted) { const found = lines.find(([, refName]) => refName === name); if (found) return found[0]; }
  if (lines.length) return lines[0][0];
  throw new GitResourceError(ref ? `The repository has no branch or tag named ${ref}` : "The repository has no default branch", 502);
}

/* ---- Discovery ---- */

function skippedFile(relative: string): boolean {
  const parts = relative.split(path.sep);
  const leaf = parts.at(-1) ?? "";
  return parts.some((part) => SKIPPED_DIRECTORIES.has(part)) || leaf === ".env" || leaf.startsWith(".env.")
    || [".npmrc", ".pypirc", ".netrc", "credentials.json"].includes(leaf) || /^service-account.*\.json$/i.test(leaf)
    || /^id_(rsa|ed25519|ecdsa)/.test(leaf) || /\.(pem|key|p12|pfx|log)$/i.test(leaf) || leaf.includes(".sync-conflict-");
}

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return false; throw error; }
}

async function readJsonObject(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function describeServer(value: unknown): string | undefined {
  const server = record(value);
  if (typeof server.command === "string" && server.command) return `stdio · ${path.basename(server.command)}`;
  if (typeof server.url === "string" && server.url) {
    try { return `${server.type === "sse" ? "sse" : "http"} · ${new URL(server.url).origin}`; } catch { return "http · remote"; }
  }
  return undefined;
}

function mcpServersIn(config: Record<string, unknown>): Record<string, unknown> {
  if (config.mcpServers !== undefined) return record(config.mcpServers);
  // A plugin-style file is the server map itself.
  const entries = Object.entries(config);
  return entries.length && entries.every(([, value]) => describeServer(value)) ? config : {};
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

const posix = (relative: string) => relative.split(path.sep).join("/") || ".";

/** Lists the skills, plugins and MCP servers in a checkout. Nothing is installed. */
export async function discoverGitItems(checkout: string): Promise<GitResourceItem[]> {
  const items: GitResourceItem[] = [];
  const plugins: Array<{ directory: string; name: string }> = [];
  const pluginOf = (directory: string) => plugins.filter((plugin) => inside(plugin.directory, directory)).sort((a, b) => b.directory.length - a.directory.length)[0];
  const addPlugin = (directory: string, name: string, description: string) => {
    if (plugins.some((plugin) => plugin.directory === directory)) return;
    plugins.push({ directory, name });
    items.push({ key: `plugin:${posix(path.relative(checkout, directory))}`, kind: "plugin", name, description, path: posix(path.relative(checkout, directory)) });
  };
  const queue: Array<{ directory: string; depth: number }> = [{ directory: checkout, depth: 0 }];
  let visited = 0;
  while (queue.length && visited < MAX_SCAN_DIRECTORIES) {
    const { directory, depth } = queue.shift()!;
    visited += 1;
    let entries;
    try { entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)); } catch { continue; }
    const names = new Set(entries.map((entry) => entry.name));
    const relative = posix(path.relative(checkout, directory));
    if (names.has(".claude-plugin")) {
      const manifest = await readJsonObject(path.join(directory, ".claude-plugin/plugin.json"));
      if (manifest) addPlugin(directory, typeof manifest.name === "string" && manifest.name ? manifest.name : path.basename(directory), typeof manifest.description === "string" ? manifest.description : "");
      const marketplace = await readJsonObject(path.join(directory, ".claude-plugin/marketplace.json"));
      const pluginRoot = typeof record(marketplace?.metadata).pluginRoot === "string" ? record(marketplace?.metadata).pluginRoot as string : ".";
      for (const entry of Array.isArray(marketplace?.plugins) ? marketplace.plugins : []) {
        const plugin = record(entry);
        if (typeof plugin.source !== "string" || typeof plugin.name !== "string" || !plugin.name) continue;
        const target = path.resolve(directory, plugin.source.startsWith(".") ? plugin.source : path.join(pluginRoot, plugin.source));
        // A marketplace entry for the repository root lists its skills, which are found one by one.
        if (target === path.resolve(checkout) || !inside(checkout, target) || !await exists(target)) continue;
        const hasManifest = await exists(path.join(target, ".claude-plugin/plugin.json"));
        const hasParts = (await Promise.all(["commands", "agents", "skills", "hooks"].map((part) => exists(path.join(target, part))))).some(Boolean);
        if (hasManifest || hasParts) addPlugin(target, plugin.name, typeof plugin.description === "string" ? plugin.description : "");
      }
    }
    if (names.has("SKILL.md")) {
      const fields = parseResourceFrontmatter(await readFile(path.join(directory, "SKILL.md"), "utf8").catch(() => ""));
      const name = fields.name || path.basename(directory);
      let error: string | undefined;
      try { validateSkillName(name); } catch { error = "The skill name is not a valid folder name"; }
      if (!error && !fields.description?.trim()) error = "SKILL.md has no description";
      if (!error && items.some((item) => item.kind === "skill" && item.name === name && !item.error)) error = "Another skill in this repository has the same name";
      const plugin = pluginOf(directory);
      items.push({ key: `skill:${relative}`, kind: "skill", name, description: fields.description ?? "", path: relative, ...(plugin ? { plugin: plugin.name } : {}), ...(error ? { error } : {}) });
      continue;
    }
    for (const file of [".mcp.json", "mcp.json"]) {
      if (!names.has(file) || pluginOf(directory)) continue;
      const config = await readJsonObject(path.join(directory, file));
      const fileRelative = posix(path.relative(checkout, path.join(directory, file)));
      for (const [name, value] of Object.entries(mcpServersIn(config ?? {}))) {
        const description = describeServer(value);
        if (!description) continue;
        items.push({ key: `mcp:${fileRelative}#${name}`, kind: "mcp", name, description, path: fileRelative });
      }
    }
    if (depth >= MAX_SCAN_DEPTH) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      queue.push({ directory: path.join(directory, entry.name), depth: depth + 1 });
    }
  }
  const order: Record<GitItemKind, number> = { skill: 0, plugin: 1, mcp: 2 };
  return items.sort((left, right) => order[left.kind] - order[right.kind] || left.name.localeCompare(right.name) || left.key.localeCompare(right.key));
}

/** Runs only the existing hook-disabled Git transport for webhook-private skill imports. */
export async function withGitSkillCheckout<T>(urlInput: string, refInput: string | null, expectedCommit: string | null, action: (checkout: string, commit: string, skills: GitResourceItem[]) => Promise<T>, options: GitResourceOptions = {}): Promise<T> {
  const checkout = path.join(resolveDataDirectory(options.dataDir), "webhook-git-staging", randomUUID());
  try {
    const commit = await checkoutCommit(checkout, normalizeGitUrl(urlInput), normalizeGitRef(refInput), expectedCommit ?? undefined);
    const skills = (await discoverGitItems(checkout)).filter(item => item.kind === "skill" && !item.error);
    return await action(checkout, commit, skills);
  } finally { await rm(checkout, { recursive: true, force: true }); }
}

/* ---- Digests ---- */

async function treeFiles(directory: string, relative = "", files: string[] = []): Promise<string[]> {
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const next = relative ? path.join(relative, entry.name) : entry.name;
    if (skippedFile(next) || entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await treeFiles(directory, next, files);
    else if (entry.isFile()) files.push(next);
  }
  return files;
}

async function treeDigest(directory: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of (await treeFiles(directory)).sort()) {
    const info = await lstat(path.join(directory, file));
    hash.update(`${posix(file)}\0${info.mode & 0o111}\0`);
    hash.update(await readFile(path.join(directory, file)));
  }
  return hash.digest("hex");
}

const valueDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/* ---- Installing ---- */

function aliasRoots(): string[] {
  const settings = getSettings();
  return [path.join(os.homedir(), ".agents/skills"), path.join(settings.pi.configPath, "skills"), path.join(settings.claude.configPath, "skills")];
}

function pluginFolderName(name: string): string { return name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "_"); }

function installedLocation(item: Pick<InstalledGitItem, "kind" | "name">, options: GitResourceOptions): string {
  const paths = agentResourcePaths(options.root);
  return item.kind === "skill" ? path.join(paths.sharedSkills, item.name) : item.kind === "plugin" ? path.join(paths.claudePlugins, pluginFolderName(item.name)) : paths.mcpConfig;
}

/** The server as it is written into the managed configuration: a command relative to its file runs from the clone. */
async function mcpServerValue(checkout: string, item: GitResourceItem): Promise<Record<string, unknown>> {
  const config = await readJsonObject(path.join(checkout, item.path));
  const value = record(mcpServersIn(config ?? {})[item.name]);
  if (!describeServer(value)) throw new GitResourceError(`${item.name} is no longer an MCP server in ${item.path}`);
  const base = path.dirname(path.join(checkout, item.path));
  const local = (candidate: unknown) => typeof candidate === "string" && (candidate.startsWith("./") || candidate.startsWith("../"));
  return { ...value, ...(local(value.command) ? { command: path.resolve(base, value.command as string) } : {}), ...(local(value.cwd) ? { cwd: path.resolve(base, value.cwd as string) } : {}) };
}

async function readMcpConfig(options: GitResourceOptions): Promise<Record<string, unknown>> {
  return (await readJsonObject(agentResourcePaths(options.root).mcpConfig)) ?? {};
}

async function writeMcpConfig(config: Record<string, unknown>, options: GitResourceOptions): Promise<void> {
  const file = agentResourcePaths(options.root).mcpConfig;
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

/** What the installed copy hashes to now; undefined when it is gone. */
async function currentDigest(item: InstalledGitItem, options: GitResourceOptions): Promise<string | undefined> {
  if (item.kind === "mcp") {
    const value = record((await readMcpConfig(options)).mcpServers)[item.name];
    return value === undefined ? undefined : valueDigest(value);
  }
  const location = installedLocation(item, options);
  if (!await exists(location)) return undefined;
  return treeDigest(location);
}

async function sourceDigest(checkout: string, item: GitResourceItem): Promise<string> {
  return item.kind === "mcp" ? valueDigest(await mcpServerValue(checkout, item)) : treeDigest(path.join(checkout, item.path));
}

function owningSource(store: Store, item: Pick<InstalledGitItem, "kind" | "name">, except: GitResourceSource): GitResourceSource | undefined {
  return store.sources.find((source) => source !== except && source.installed.some((other) => other.kind === item.kind && other.name === item.name));
}

async function copyPlugin(sourceDirectory: string, destination: string, item: GitResourceItem, backups: string[], options: GitResourceOptions): Promise<void> {
  const files = await treeFiles(sourceDirectory);
  let bytes = 0;
  for (const file of files) bytes += (await lstat(path.join(sourceDirectory, file))).size;
  if (files.length > MAX_PLUGIN_FILES || bytes > MAX_PLUGIN_BYTES) throw new GitResourceError(`Plugin ${item.name} is larger than ${MAX_PLUGIN_BYTES / 1024 / 1024} MB or ${MAX_PLUGIN_FILES} files`);
  const staged = `${destination}.${randomUUID()}.staging`;
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await cp(sourceDirectory, staged, { recursive: true, verbatimSymlinks: true, filter: async (candidate) => {
      const relative = path.relative(sourceDirectory, candidate);
      return !relative || (!skippedFile(relative) && !(await lstat(candidate)).isSymbolicLink());
    } });
    const manifest = path.join(staged, ".claude-plugin/plugin.json");
    if (!await exists(manifest)) {
      await mkdir(path.dirname(manifest), { recursive: true });
      await writeFile(manifest, `${JSON.stringify({ name: item.name, ...(item.description ? { description: item.description } : {}) }, null, 2)}\n`);
    }
    if (await exists(destination)) {
      const backup = path.join(resolveDataDirectory(options.dataDir), "agent-resources-backups", randomUUID(), "plugins", path.basename(destination));
      await mkdir(path.dirname(backup), { recursive: true });
      await rename(destination, backup);
      backups.push(backup);
    }
    await rename(staged, destination);
  } finally { await rm(staged, { recursive: true, force: true }); }
}

async function installItem(store: Store, source: GitResourceSource, checkout: string, item: GitResourceItem, result: GitApplyResult, options: GitResourceOptions): Promise<void> {
  if (item.error) throw new GitResourceError(`${item.name}: ${item.error}`);
  const prior = source.installed.find((entry) => entry.key === item.key);
  const owner = owningSource(store, item, source);
  if (owner) throw new GitResourceError(`${item.name} is already installed from ${owner.url}`, 409);
  const digest = await sourceDigest(checkout, item);
  const location = installedLocation(item, options);
  if (prior) {
    const current = await currentDigest(prior, options);
    if (current === undefined) {
      // Removed here since it was installed: the person who removed it decides, not an update.
      source.installed = source.installed.filter((entry) => entry !== prior);
      result.kept.push(`${item.name} (removed on this node)`);
      return;
    }
    if (prior.sourceDigest === digest) {
      // Edits made here survive until the repository itself changes the item.
      if (current === prior.installedDigest) result.unchanged.push(item.name); else result.kept.push(`${item.name} (edited on this node)`);
      return;
    }
  }
  if (item.kind === "skill") {
    const paths = agentResourcePaths(options.root);
    const provenance = await receivedOwner(paths.sharedSkills, item.name, options.dataDir);
    // A received skill removed here stays removed; on its own repositories the person ticking it decides.
    if (!prior && source.ownerNodeId && await skillSuppressed(paths.sharedSkills, item.name, options.dataDir)) { result.kept.push(`${item.name} (removed on this node)`); return; }
    if (!prior && await exists(location)) throw new GitResourceError(`A managed skill named ${item.name} already exists on this node; remove it in the Skills tab first`, 409);
    if (provenance && provenance !== source.ownerNodeId) throw new GitResourceError(`${item.name} is a skill another node shares with this one`, 409);
    // A received copy is marked as the owner's, so it is never reshared from here; the import itself refuses marked skills.
    if (provenance) await unmarkReceived(paths.sharedSkills, item.name, options.dataDir);
    try {
      const published = await syncLocalSkills([path.join(checkout, item.path)], options);
      if (![...published.published, ...published.unchanged].includes(item.name)) throw new GitResourceError(`${item.name}: the skill's name does not match its SKILL.md`);
      if (published.backupPath) result.backups.push(published.backupPath);
    } finally {
      if (source.ownerNodeId && await exists(location)) await markReceived(paths.sharedSkills, item.name, source.ownerNodeId, options.dataDir);
    }
    result.skillsChanged = true;
  } else if (item.kind === "plugin") {
    if (!prior && await exists(location)) throw new GitResourceError(`A managed plugin named ${item.name} already exists on this node`, 409);
    await copyPlugin(path.join(checkout, item.path), location, item, result.backups, options);
  } else {
    const config = await readMcpConfig(options);
    const servers = { ...record(config.mcpServers) };
    const value = await mcpServerValue(checkout, item);
    if (!prior && servers[item.name] !== undefined && valueDigest(servers[item.name]) !== valueDigest(value)) throw new GitResourceError(`An MCP server named ${item.name} is already configured on this node`, 409);
    servers[item.name] = value;
    await writeMcpConfig({ ...config, mcpServers: servers }, options);
  }
  const installed: InstalledGitItem = { key: item.key, kind: item.kind, name: item.name, sourceDigest: digest, installedDigest: (await currentDigest({ ...item, sourceDigest: digest, installedDigest: "" }, options)) ?? "" };
  source.installed = [...source.installed.filter((entry) => entry.key !== item.key), installed];
  if (source.ownerNodeId && item.kind !== "skill") markReceivedResource(item.kind, item.kind === "plugin" ? pluginFolderName(item.name) : item.name, true);
  result.installed.push(item.name);
}

async function uninstallItem(source: GitResourceSource, item: InstalledGitItem, result: GitApplyResult, options: GitResourceOptions, removeEdited = false): Promise<void> {
  // Materialize legacy provenance before its source record can disappear, including failed removals.
  if (source.ownerNodeId && item.kind !== "skill") markReceivedResource(item.kind, item.kind === "plugin" ? pluginFolderName(item.name) : item.name, true);
  const current = await currentDigest(item, options);
  const forget = (): void => { source.installed = source.installed.filter((entry) => entry.key !== item.key); };
  const clearProvenance = (): void => {
    if (source.ownerNodeId && item.kind !== "skill") markReceivedResource(item.kind, item.kind === "plugin" ? pluginFolderName(item.name) : item.name, false);
  };
  // Retained edits and failed removals stay received, never silently becoming auto-enabled local resources.
  if (current === undefined) { forget(); clearProvenance(); result.removed.push(item.name); return; }
  if (current !== item.installedDigest && !removeEdited) { forget(); result.kept.push(`${item.name} (edited on this node)`); return; }
  const location = installedLocation(item, options);
  if (item.kind === "skill") {
    result.backups.push(await backupRemovedSkill(location, options.dataDir));
    await unlinkSkillAliases(location, aliasRoots());
    if (source.ownerNodeId) await unmarkReceived(agentResourcePaths(options.root).sharedSkills, item.name, options.dataDir);
    result.skillsChanged = true;
  } else if (item.kind === "plugin") {
    const backup = path.join(resolveDataDirectory(options.dataDir), "removed-plugins", randomUUID(), path.basename(location));
    await mkdir(path.dirname(backup), { recursive: true });
    await rename(location, backup);
    result.backups.push(backup);
  } else {
    const config = await readMcpConfig(options);
    const servers = { ...record(config.mcpServers) };
    if (removeEdited && current !== item.installedDigest) {
      const backup = path.join(resolveDataDirectory(options.dataDir), "removed-mcp", randomUUID(), "server.json");
      await mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
      await writeFile(backup, `${JSON.stringify({ name: item.name, config: servers[item.name] }, null, 2)}\n`, { mode: 0o600 });
      result.backups.push(backup);
    }
    delete servers[item.name];
    await writeMcpConfig({ ...config, mcpServers: servers }, options);
  }
  forget();
  clearProvenance();
  result.removed.push(item.name);
}

const emptyResult = (): GitApplyResult => ({ installed: [], unchanged: [], removed: [], kept: [], errors: [], backups: [], skillsChanged: false });

/** Makes what is installed from a repository match the chosen keys at the clone's commit. */
async function reconcileSelection(store: Store, source: GitResourceSource, keys: string[], options: GitResourceOptions): Promise<GitApplyResult> {
  const result = emptyResult();
  const checkout = checkoutOf(source, options);
  const items = await discoverGitItems(checkout);
  const wanted = new Set(keys);
  for (const installed of [...source.installed]) {
    if (wanted.has(installed.key)) continue;
    try { await uninstallItem(source, installed, result, options); }
    catch (error) { result.errors.push(`${installed.name}: ${(error as Error).message}`); }
  }
  for (const key of wanted) {
    const item = items.find((candidate) => candidate.key === key);
    if (!item) {
      if (source.installed.some((entry) => entry.key === key)) result.kept.push(`${key.split(":").slice(1).join(":")} (no longer in the repository)`);
      else result.errors.push(`${key}: not in the repository`);
      continue;
    }
    try { await installItem(store, source, checkout, item, result, options); }
    catch (error) { result.errors.push(error instanceof GitResourceError && error.message.startsWith(item.name) ? error.message : `${item.name}: ${(error as Error).message}`); }
  }
  source.lastError = result.errors.length ? result.errors.join("; ") : null;
  source.updatedAt = new Date().toISOString();
  return result;
}

/* ---- Views ---- */

function label(url: string): string {
  const trimmed = url.replace(/\.git$/, "").replace(/\/+$/, "");
  const match = /[:/]([^/:]+\/[^/:]+)$/.exec(trimmed);
  return match ? match[1] : trimmed;
}

async function sourceView(source: GitResourceSource, options: GitResourceOptions): Promise<GitSourceView> {
  const checkout = checkoutOf(source, options);
  const discovered = await exists(checkout) ? await discoverGitItems(checkout) : [];
  const items: GitItemView[] = [];
  for (const item of discovered) {
    const installed = source.installed.find((entry) => entry.key === item.key);
    if (!installed) { items.push({ ...item, status: "available" }); continue; }
    const current = await currentDigest(installed, options).catch(() => undefined);
    items.push({ ...item, status: current === undefined ? "removed" : current === installed.installedDigest ? "imported" : "edited" });
  }
  for (const installed of source.installed) {
    if (!discovered.some((item) => item.key === installed.key)) items.push({ key: installed.key, kind: installed.kind, name: installed.name, description: "No longer in the repository", path: installed.key.split(":").slice(1).join(":"), status: "gone" });
  }
  const { gitlabAccountId, ...publicSource } = source;
  return { ...publicSource, usesGitLabCredential: Boolean(gitlabAccountId), label: label(source.url), updateAvailable: Boolean(source.latestCommit && source.latestCommit !== source.commit), items };
}

export async function listGitSources(options: GitResourceOptions = {}): Promise<GitSourceView[]> {
  const store = await readStore(options);
  return Promise.all(store.sources.map((source) => sourceView(source, options)));
}

export async function gitSourceView(id: string, ownerNodeId: string | null = null, options: GitResourceOptions = {}): Promise<GitSourceView> {
  return sourceView(findSource(await readStore(options), id, ownerNodeId), options);
}

/* ---- Operations on this node's own repositories ---- */

export function addGitSource(input: { url: string; ref?: string | null; gitlabAccountId?: string | null }, options: GitResourceOptions = {}): Promise<GitSourceView> {
  const url = normalizeGitUrl(input.url), ref = normalizeGitRef(input.ref);
  return withGitResourceMutation(async () => {
    const store = await readStore(options);
    if (store.sources.some((source) => !source.ownerNodeId && source.url === url && source.ref === ref)) throw new GitResourceError("That repository is already added", 409);
    const now = new Date().toISOString();
    const gitlabAccountId = input.gitlabAccountId || undefined;
    let credentials: NodeJS.ProcessEnv | undefined;
    if (gitlabAccountId) {
      try { credentials = gitlabGitEnvironment(gitlabAccountId, url); }
      catch (error) { throw new GitResourceError((error as Error).message, 400); }
    }
    const source: GitResourceSource = { id: randomUUID(), url, ref, ...(gitlabAccountId ? { gitlabAccountId } : {}), commit: "", ownerNodeId: null, autoUpdate: false, recipients: [], deliveries: {},
      latestCommit: null, checkedAt: now, checkError: null, installed: [], lastError: null, addedAt: now, updatedAt: now };
    source.commit = await cloneInto(checkoutOf(source, options), url, ref, credentials);
    source.latestCommit = source.commit;
    store.sources.push(source);
    await writeStore(store, options);
    return sourceView(source, options);
  });
}

/** Installs the chosen items and removes the rest that came from this repository. */
export function applyGitSelection(id: string, keys: string[], options: GitResourceOptions = {}): Promise<GitApplyResult> {
  return withGitResourceMutation(async () => {
    const store = await readStore(options);
    const source = findSource(store, id);
    const result = await reconcileSelection(store, source, [...new Set(keys)], options);
    await writeStore(store, options);
    return result;
  });
}

/** Asks the remote for the ref's commit. Nothing is fetched or installed. */
export function checkGitSource(id: string, options: GitResourceOptions = {}): Promise<GitSourceView> {
  return withGitResourceMutation(async () => {
    const store = await readStore(options);
    const source = findSource(store, id);
    source.checkedAt = new Date().toISOString();
    try { source.latestCommit = await remoteCommit(source.url, source.ref, source.gitlabAccountId ? gitlabGitEnvironment(source.gitlabAccountId, source.url) : undefined); source.checkError = null; }
    catch (error) { source.checkError = (error as Error).message; }
    await writeStore(store, options);
    return sourceView(source, options);
  });
}

/** Fetches the ref's newest commit and installs the selected items again from it. */
export function updateGitSource(id: string, options: GitResourceOptions = {}): Promise<GitApplyResult & { commit: string; previousCommit: string }> {
  return withGitResourceMutation(async () => {
    const store = await readStore(options);
    const source = findSource(store, id);
    const previousCommit = source.commit;
    source.commit = await checkoutCommit(checkoutOf(source, options), source.url, source.ref, undefined, source.gitlabAccountId ? gitlabGitEnvironment(source.gitlabAccountId, source.url) : undefined);
    source.latestCommit = source.commit;
    source.checkedAt = new Date().toISOString();
    source.checkError = null;
    const result = await reconcileSelection(store, source, source.installed.map((item) => item.key), options);
    await writeStore(store, options);
    return { ...result, commit: source.commit, previousCommit };
  });
}

export function setGitSourceOptions(id: string, change: { autoUpdate?: boolean; recipients?: string[] }, options: GitResourceOptions = {}): Promise<{ source: GitSourceView; removedRecipients: string[] }> {
  return withGitResourceMutation(async () => {
    const store = await readStore(options);
    const source = findSource(store, id);
    if (change.autoUpdate !== undefined) source.autoUpdate = change.autoUpdate;
    let removedRecipients: string[] = [];
    if (change.recipients) {
      const next = [...new Set(change.recipients)].sort();
      removedRecipients = source.recipients.filter((nodeId) => !next.includes(nodeId));
      source.recipients = next;
      for (const nodeId of removedRecipients) delete source.deliveries[nodeId];
    }
    source.updatedAt = new Date().toISOString();
    await writeStore(store, options);
    return { source: await sourceView(source, options), removedRecipients };
  });
}

/** Explicit removal backs up edited assets, removes its installed items, then forgets the repository only if cleanup succeeded. */
export function removeGitSource(id: string, ownerNodeId: string | null = null, options: GitResourceOptions = {}): Promise<GitApplyResult & { recipients: string[]; complete: boolean }> {
  return withGitResourceMutation(async () => {
    const store = await readStore(options);
    const source = findSource(store, id, ownerNodeId);
    const result = emptyResult();
    for (const item of [...source.installed]) {
      try { await uninstallItem(source, item, result, options, true); }
      catch (error) { result.errors.push(`${item.name}: ${(error as Error).message}`); }
    }
    const complete = result.errors.length === 0;
    if (complete) store.sources = store.sources.filter((candidate) => candidate !== source);
    else { source.lastError = result.errors.join("; "); source.updatedAt = new Date().toISOString(); }
    await writeStore(store, options);
    if (complete) await rm(checkoutOf(source, options), { recursive: true, force: true });
    return { ...result, recipients: source.recipients, complete };
  });
}

export function recordGitDeliveries(id: string, deliveries: Record<string, GitDelivery>, options: GitResourceOptions = {}): Promise<void> {
  return withGitResourceMutation(async () => {
    const store = await readStore(options);
    const source = store.sources.find((candidate) => candidate.id === id && !candidate.ownerNodeId);
    if (!source) return;
    for (const [nodeId, delivery] of Object.entries(deliveries)) if (source.recipients.includes(nodeId)) source.deliveries[nodeId] = delivery;
    await writeStore(store, options);
  });
}

/* ---- Sharing between nodes ---- */

export interface GitOffer { id: string; url: string; ref: string | null; commit: string; keys: string[] }

/** What a recipient should run: each shared repository at this node's commit, with this node's selection. */
export async function gitOffersFor(nodeId: string, options: GitResourceOptions = {}): Promise<GitOffer[]> {
  return (await readStore(options)).sources.filter((source) => !source.ownerNodeId && source.recipients.includes(nodeId))
    .map((source) => ({ id: source.id, url: source.url, ref: source.ref, commit: source.commit, keys: source.installed.map((item) => item.key).sort() }));
}

/** Applies everything one owner shares with this node; repositories it no longer offers are removed. */
export function applyGitOffers(ownerNodeId: string, offers: GitOffer[], options: GitResourceOptions = {}): Promise<{ applied: string[]; errors: string[]; skillsChanged: boolean }> {
  return withGitResourceMutation(async () => {
    const store = await readStore(options);
    const applied: string[] = [], errors: string[] = [];
    let skillsChanged = false;
    for (const prior of store.sources.filter((source) => source.ownerNodeId === ownerNodeId && !offers.some((offer) => offer.id === source.id))) {
      const result = emptyResult();
      for (const item of [...prior.installed]) {
        try { await uninstallItem(prior, item, result, options); } catch (error) { errors.push(`${item.name}: ${(error as Error).message}`); }
      }
      skillsChanged ||= result.skillsChanged;
      store.sources = store.sources.filter((source) => source !== prior);
      await rm(checkoutOf(prior, options), { recursive: true, force: true });
    }
    for (const offer of offers) {
      const now = new Date().toISOString();
      let source = store.sources.find((candidate) => candidate.id === offer.id && candidate.ownerNodeId === ownerNodeId);
      if (!source) {
        source = { id: offer.id, url: offer.url, ref: offer.ref, commit: "", ownerNodeId, autoUpdate: false, recipients: [], deliveries: {},
          latestCommit: offer.commit, checkedAt: null, checkError: null, installed: [], lastError: null, addedAt: now, updatedAt: now };
        store.sources.push(source);
      }
      try {
        const url = normalizeGitUrl(offer.url), ref = normalizeGitRef(offer.ref);
        if (!commitPattern.test(offer.commit)) throw new GitResourceError("The sharing node sent an invalid commit");
        source.url = url; source.ref = ref; source.latestCommit = offer.commit;
        if (source.commit !== offer.commit || !await exists(checkoutOf(source, options))) source.commit = await checkoutCommit(checkoutOf(source, options), url, ref, offer.commit);
        const result = await reconcileSelection(store, source, offer.keys, options);
        skillsChanged ||= result.skillsChanged;
        errors.push(...result.errors);
        applied.push(source.id);
      } catch (error) {
        source.lastError = (error as Error).message;
        source.updatedAt = now;
        errors.push(`${label(offer.url)}: ${(error as Error).message}`);
      }
    }
    await writeStore(store, options);
    return { applied, errors, skillsChanged };
  });
}
