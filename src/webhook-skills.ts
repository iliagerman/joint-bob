import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { defaultSkillRoots, listSkills, parseResourceFrontmatter } from "./skills.js";
import type { SkillRoots } from "./skills.js";
import type { HarnessId } from "./types.js";
import { resolveDataDirectory } from "./data-directory.js";
import { validateSkillName } from "./skill-sharing.js";
import { ensureWebhookResourceDirectory, type WebhookResourceOptions, WebhookResourceError } from "./webhook-resources.js";

export const WEBHOOK_SKILL_MAX_BYTES = 4 * 1024 * 1024;
export const WEBHOOK_SKILL_MAX_FILES = 200;
export interface WebhookSkillFile { relativePath: string; data: Buffer }
export interface WebhookSkillRecord { id: string; webhookId: string; versionId: string; name: string; description: string; source: "upload" | "existing" | "git"; path: string; sourceUrl?: string; sourceRef?: string | null; sourceCommit?: string; sourceKey?: string }

function ensureSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS webhook_skill_versions (
    version_id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL, skill_id TEXT NOT NULL, name TEXT NOT NULL,
    description TEXT NOT NULL, source TEXT NOT NULL, relative_path TEXT NOT NULL, created_at TEXT NOT NULL,
    source_url TEXT, source_ref TEXT, source_commit TEXT, source_key TEXT);
  CREATE TABLE IF NOT EXISTS webhook_skills (
    id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL, current_version_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
  const columns = db.prepare("PRAGMA table_info(webhook_skill_versions)").all() as Array<{ name: string }>;
  for (const [name, type] of [["source_url", "TEXT"], ["source_ref", "TEXT"], ["source_commit", "TEXT"], ["source_key", "TEXT"]]) {
    if (!columns.some(column => column.name === name)) db.exec(`ALTER TABLE webhook_skill_versions ADD COLUMN ${name} ${type}`);
  }
}

function safeRelativePath(value: string): string {
  if (!value || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value)) throw new WebhookResourceError("Invalid skill file path");
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) throw new WebhookResourceError("Invalid skill file path");
  return parts.join(path.sep);
}

function activeSkills(db: DatabaseSync, webhookId: string) {
  return db.prepare(`SELECT s.id,v.version_id,v.name,v.description,v.source,v.relative_path,v.source_url,v.source_ref,v.source_commit,v.source_key
    FROM webhook_skills s JOIN webhook_skill_versions v ON v.version_id=s.current_version_id
    WHERE s.webhook_id=? ORDER BY s.created_at,s.id`).all(webhookId) as Array<Record<string, unknown>>;
}

export function listWebhookSkills(db: DatabaseSync, webhookId: string, options: WebhookResourceOptions = {}): WebhookSkillRecord[] {
  ensureSchema(db);
  const parent = path.join(options.root ?? resolveDataDirectory(), "webhook-resources", webhookId);
  return activeSkills(db, webhookId).map(row => ({ id: String(row.id), webhookId, versionId: String(row.version_id), name: String(row.name), description: String(row.description), source: row.source as WebhookSkillRecord["source"], path: path.join(parent, String(row.relative_path)), ...(row.source_url ? { sourceUrl: String(row.source_url) } : {}), ...(row.source_ref !== null ? { sourceRef: String(row.source_ref) } : {}), ...(row.source_commit ? { sourceCommit: String(row.source_commit) } : {}), ...(row.source_key ? { sourceKey: String(row.source_key) } : {}) }));
}

export async function uploadWebhookSkill(db: DatabaseSync, webhookId: string, files: WebhookSkillFile[], options: WebhookResourceOptions = {}, replaceSkillId?: string): Promise<WebhookSkillRecord> {
  ensureSchema(db);
  if (!db.prepare("SELECT 1 FROM webhooks WHERE id=?").get(webhookId)) throw new WebhookResourceError("Webhook not found", 404);
  if (!files.length || files.length > WEBHOOK_SKILL_MAX_FILES) throw new WebhookResourceError(`A skill folder needs 1–${WEBHOOK_SKILL_MAX_FILES} files`);
  const paths = files.map(file => safeRelativePath(file.relativePath));
  if (new Set(paths).size !== paths.length) throw new WebhookResourceError("Duplicate skill file path");
  const total = files.reduce((sum, file) => sum + file.data.byteLength, 0);
  if (total > WEBHOOK_SKILL_MAX_BYTES) throw new WebhookResourceError("A skill folder must be at most 4 MiB");
  const index = files.findIndex(file => file.relativePath === "SKILL.md");
  if (index < 0) throw new WebhookResourceError("Skill folder must contain SKILL.md");
  const frontmatter = parseResourceFrontmatter(files[index].data.toString("utf8"));
  const name = frontmatter.name || "";
  try { validateSkillName(name); } catch { throw new WebhookResourceError("SKILL.md must declare a valid skill name"); }
  const description = frontmatter.description?.trim() ?? "";
  if (!description) throw new WebhookResourceError("SKILL.md must declare a description");
  if (description.length > 2000) throw new WebhookResourceError("Skill description must be at most 2,000 characters");
  const currentSkills = activeSkills(db, webhookId);
  const replaced = replaceSkillId ? currentSkills.find(skill => skill.id === replaceSkillId) : undefined;
  if (replaceSkillId && !replaced) throw new WebhookResourceError("Webhook skill not found", 404);
  if (replaced && replaced.name !== name) throw new WebhookResourceError("A Git update cannot change a skill name", 409);
  if (currentSkills.some(skill => skill.name === name && skill.id !== replaceSkillId)) throw new WebhookResourceError(`Webhook already has a skill named ${name}`, 409);
  if (!replaced && currentSkills.length >= 20) throw new WebhookResourceError("A webhook can have at most 20 skills");
  const directory = await ensureWebhookResourceDirectory(webhookId, options);
  const id = replaceSkillId ?? randomUUID(), versionId = randomUUID(), now = new Date().toISOString();
  const relativePath = path.join("skills", `${versionId}-${name}`);
  const target = path.join(directory, relativePath);
  const staged = `${target}.${randomUUID()}.tmp`;
  await mkdir(staged, { recursive: true, mode: 0o700 });
  try {
    for (let index = 0; index < files.length; index += 1) {
      const destination = path.join(staged, paths[index]);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, files[index].data, { flag: "wx", mode: 0o600 });
    }
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await rename(staged, target);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`INSERT INTO webhook_skill_versions(version_id,webhook_id,skill_id,name,description,source,relative_path,created_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(versionId, webhookId, id, name, description, "upload", relativePath, now);
      if (replaced) db.prepare("UPDATE webhook_skills SET current_version_id=?,updated_at=? WHERE webhook_id=? AND id=?").run(versionId, now, webhookId, id);
      else db.prepare("INSERT INTO webhook_skills VALUES(?,?,?,?,?)").run(id, webhookId, versionId, now, now);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } catch (error) { await rm(staged, { recursive: true, force: true }); await rm(target, { recursive: true, force: true }); throw error; }
  return { id, webhookId, versionId, name, description, source: "upload", path: target };
}

async function skillFiles(directory: string): Promise<WebhookSkillFile[]> {
  const rootInfo = await lstat(directory);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new WebhookResourceError("Skill folder must be a real directory");
  const files: WebhookSkillFile[] = [];
  let total = 0;
  async function visit(folder: string, relative = ""): Promise<void> {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      const file = path.join(folder, entry.name);
      const info = await lstat(file);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new WebhookResourceError("Skill folders cannot contain symlinks or special files");
      if (info.isDirectory()) await visit(file, next);
      else {
        total += info.size;
        if (total > WEBHOOK_SKILL_MAX_BYTES || files.length >= WEBHOOK_SKILL_MAX_FILES) throw new WebhookResourceError("A skill folder exceeds its size or file limit");
        files.push({ relativePath: next, data: await readFile(file) });
      }
    }
  }
  await visit(directory);
  return files;
}

export async function discoverWebhookGitSkills(url: string, ref: string | null, options: WebhookResourceOptions = {}): Promise<{ commit: string; skills: Array<{ key: string; name: string; description: string }> }> {
  const { withGitSkillCheckout } = await import("./git-resources.js");
  return withGitSkillCheckout(url, ref, null, async (_checkout, commit, skills) => ({ commit, skills: skills.map(({ key, name, description }) => ({ key, name, description })) }), { dataDir: options.root });
}

export async function importWebhookGitSkill(db: DatabaseSync, webhookId: string, url: string, ref: string | null, commit: string, key: string, options: WebhookResourceOptions = {}, replaceSkillId?: string): Promise<WebhookSkillRecord> {
  const { withGitSkillCheckout } = await import("./git-resources.js");
  return withGitSkillCheckout(url, ref, commit, async (checkout, actualCommit, skills) => {
    const selected = skills.find(skill => skill.key === key);
    if (!selected) throw new WebhookResourceError("Selected Git skill is no longer available", 409);
    const saved = await uploadWebhookSkill(db, webhookId, await skillFiles(path.join(checkout, selected.path)), options, replaceSkillId);
    db.prepare("UPDATE webhook_skill_versions SET source='git',source_url=?,source_ref=?,source_commit=?,source_key=? WHERE version_id=?")
      .run(url, ref, actualCommit, key, saved.versionId);
    return { ...saved, source: "git" };
  }, { dataDir: options.root });
}

function skillInventoryId(skill: { harness: HarnessId; name: string; path?: string }): string {
  return createHash("sha256").update(`${skill.harness}\0${skill.name}\0${path.resolve(skill.path ?? "")}`).digest("hex");
}

function appConfiguredSkillRoots(roots: SkillRoots): SkillRoots {
  return { shared: roots.shared, global: roots.global, project: roots.project };
}

export async function listSelectableWebhookSkills(projectPath: string, harness?: HarnessId, configuredRoots: SkillRoots = defaultSkillRoots()): Promise<Array<{ inventoryId: string; name: string; description: string; harness: HarnessId }>> {
  const skills = await listSkills(projectPath, appConfiguredSkillRoots(configuredRoots));
  return skills.filter(skill => !harness || skill.harness === harness).map(skill => ({
    inventoryId: skillInventoryId(skill), name: skill.name, description: skill.description, harness: skill.harness,
  }));
}

export async function importExistingWebhookSkill(db: DatabaseSync, webhookId: string, projectPath: string, inventoryId: string, options: WebhookResourceOptions = {}, configuredRoots: SkillRoots = defaultSkillRoots()): Promise<WebhookSkillRecord> {
  const selected = (await listSkills(projectPath, appConfiguredSkillRoots(configuredRoots))).find(skill => skillInventoryId(skill) === inventoryId);
  if (!selected?.path) throw new WebhookResourceError("Selected skill is no longer available", 409);
  const saved = await uploadWebhookSkill(db, webhookId, await skillFiles(selected.path), options);
  db.prepare("UPDATE webhook_skill_versions SET source='existing',source_key=? WHERE version_id=?").run(inventoryId, saved.versionId);
  return { ...saved, source: "existing" };
}

export async function removeWebhookSkill(db: DatabaseSync, webhookId: string, id: string): Promise<void> {
  ensureSchema(db);
  const result = db.prepare("DELETE FROM webhook_skills WHERE webhook_id=? AND id=?").run(webhookId, id);
  if (!result.changes) throw new WebhookResourceError("Webhook skill not found", 404);
}

export async function resolveWebhookSkillVersions(db: DatabaseSync, webhookId: string, versionIds: string[], options: WebhookResourceOptions = {}): Promise<string[]> {
  ensureSchema(db);
  const root = await ensureWebhookResourceDirectory(webhookId, options);
  return Promise.all(versionIds.map(async versionId => {
    const row = db.prepare("SELECT relative_path FROM webhook_skill_versions WHERE webhook_id=? AND version_id=?").get(webhookId, versionId) as { relative_path: string } | undefined;
    if (!row) throw new WebhookResourceError("A webhook skill version is no longer available", 409);
    const folder = path.join(root, row.relative_path);
    const info = await lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new WebhookResourceError("A webhook skill version is unavailable", 409);
    return folder;
  }));
}
