import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getSharingCluster, listSharingClusterMembers, listSharingMemberships } from "./cluster-sharing-policy.js";
import { parseResourceFrontmatter } from "./skills.js";

export const MAX_SKILL_BYTES = 2 * 1024 * 1024;
export const MAX_SKILL_FILES = 512;
export interface SkillBundleFile { path: string; content: string; executable: boolean }
export interface SkillBundle { files: SkillBundleFile[] }
export interface ReceivedSkill { ownerNodeId: string; name: string; digest: string; updatedAt: string }
export interface SkillConversationGrant { projectId: string; conversationId: string }
/** Grants narrower than a node: a workspace's projects, or single conversations. */
export interface SkillScopeGrants { workspaceIds: string[]; conversations: SkillConversationGrant[] }
export interface ReceivedScopedSkill extends ReceivedSkill { projectIds: string[]; conversations: SkillConversationGrant[] }

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const skillName = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/;
const conversationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,299}$/;

export function validateSkillName(name: string): void {
  if (!skillName.test(name) || name === "." || name === "..") throw new Error("Invalid skill name");
}

function validateUuid(value: string): void {
  if (!uuid.test(value)) throw new Error("Invalid cluster ID");
}

export function ensureSkillSharingSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS skill_shares(name TEXT NOT NULL,cluster_id TEXT NOT NULL,owner_join_sequence INTEGER NOT NULL,PRIMARY KEY(name,cluster_id));
CREATE TABLE IF NOT EXISTS received_skills(owner_node_id TEXT NOT NULL,name TEXT NOT NULL,digest TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner_node_id,name),UNIQUE(name));
CREATE TABLE IF NOT EXISTS skill_peer_status(owner_node_id TEXT PRIMARY KEY,last_success TEXT,last_error TEXT);
CREATE TABLE IF NOT EXISTS skill_node_shares(name TEXT NOT NULL,node_id TEXT NOT NULL,cluster_id TEXT NOT NULL,owner_join_sequence INTEGER NOT NULL,receiver_join_sequence INTEGER NOT NULL,PRIMARY KEY(name,node_id));
CREATE TABLE IF NOT EXISTS skill_scope_shares(name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('workspace','conversation')),target_id TEXT NOT NULL,project_id TEXT NOT NULL DEFAULT '',PRIMARY KEY(name,kind,target_id,project_id));
CREATE TABLE IF NOT EXISTS received_scoped_skills(owner_node_id TEXT NOT NULL,name TEXT NOT NULL,digest TEXT NOT NULL,updated_at TEXT NOT NULL,project_ids TEXT NOT NULL,conversations TEXT NOT NULL,PRIMARY KEY(owner_node_id,name),UNIQUE(name));`);
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

/** Only workspaces this node owns can be named; a received "Shared projects" workspace belongs to its owner. */
function validateScopes(db: DatabaseSync, scopes: SkillScopeGrants): void {
  if (new Set(scopes.workspaceIds).size !== scopes.workspaceIds.length) throw new Error("Duplicate workspace selection");
  const conversationKeys = scopes.conversations.map((item) => `${item.projectId}\0${item.conversationId}`);
  if (new Set(conversationKeys).size !== conversationKeys.length) throw new Error("Duplicate conversation selection");
  const received = hasTable(db, "cluster_v2_project_workspaces") ? db.prepare("SELECT 1 FROM cluster_v2_project_workspaces WHERE workspace_id=?") : undefined;
  for (const workspaceId of scopes.workspaceIds) {
    if (!db.prepare("SELECT 1 FROM workspaces WHERE id=?").get(workspaceId) || received?.get(workspaceId)) throw new Error("Workspace is not on this node");
  }
  for (const { projectId, conversationId } of scopes.conversations) {
    if (!conversationIdPattern.test(conversationId)) throw new Error("Invalid conversation ID");
    if (!db.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId)) throw new Error("Conversation's project is not on this node");
  }
}

export function skillScopeGrants(db: DatabaseSync, name: string): SkillScopeGrants {
  ensureSkillSharingSchema(db);
  validateSkillName(name);
  const rows = db.prepare("SELECT kind,target_id,project_id FROM skill_scope_shares WHERE name=? ORDER BY kind,project_id,target_id").all(name) as unknown as Array<{ kind: string; target_id: string; project_id: string }>;
  return {
    workspaceIds: rows.filter((row) => row.kind === "workspace").map((row) => row.target_id),
    conversations: rows.filter((row) => row.kind === "conversation").map((row) => ({ projectId: row.project_id, conversationId: row.target_id })),
  };
}

export function setSkillShares(db: DatabaseSync, ownerNodeId: string, name: string, clusterIds: string[], nodeIds: string[] = [], scopes: SkillScopeGrants = { workspaceIds: [], conversations: [] }): void {
  ensureSkillSharingSchema(db);
  validateSkillName(name);
  validateScopes(db, scopes);
  if (new Set(clusterIds).size !== clusterIds.length) throw new Error("Duplicate cluster selection");
  if (new Set(nodeIds).size !== nodeIds.length) throw new Error("Duplicate node selection");
  const owned = listSharingMemberships(db, ownerNodeId);
  const rows = clusterIds.map((clusterId) => {
    validateUuid(clusterId);
    if (getSharingCluster(db, clusterId).closed) throw new Error("Cluster is closed");
    const membership = owned.find((item) => item.clusterId === clusterId);
    if (!membership) throw new Error("Owner is not a cluster member");
    return { clusterId, sequence: membership.joinSequence };
  });
  const nodeRows = nodeIds.map((nodeId) => {
    validateUuid(nodeId);
    if (nodeId === ownerNodeId) throw new Error("A node cannot share a skill with itself");
    // A node grant rides one shared cluster, so leaving it revokes the grant.
    for (const membership of owned) {
      if (getSharingCluster(db, membership.clusterId).closed) continue;
      const receiver = listSharingClusterMembers(db, membership.clusterId).find((member) => member.nodeId === nodeId);
      if (receiver) return { nodeId, clusterId: membership.clusterId, ownerSequence: membership.joinSequence, receiverSequence: receiver.joinSequence };
    }
    throw new Error("Node shares no open cluster with this node");
  });
  db.exec("SAVEPOINT skill_share_write");
  try {
    db.prepare("DELETE FROM skill_shares WHERE name=?").run(name);
    db.prepare("DELETE FROM skill_node_shares WHERE name=?").run(name);
    const insert = db.prepare("INSERT INTO skill_shares VALUES(?,?,?)");
    for (const row of rows) insert.run(name, row.clusterId, row.sequence);
    const insertNode = db.prepare("INSERT INTO skill_node_shares VALUES(?,?,?,?,?)");
    for (const row of nodeRows) insertNode.run(name, row.nodeId, row.clusterId, row.ownerSequence, row.receiverSequence);
    db.prepare("DELETE FROM skill_scope_shares WHERE name=?").run(name);
    const insertScope = db.prepare("INSERT INTO skill_scope_shares VALUES(?,?,?,?)");
    for (const workspaceId of scopes.workspaceIds) insertScope.run(name, "workspace", workspaceId, "");
    for (const item of scopes.conversations) insertScope.run(name, "conversation", item.conversationId, item.projectId);
    db.exec("RELEASE skill_share_write");
  } catch (error) {
    db.exec("ROLLBACK TO skill_share_write; RELEASE skill_share_write");
    throw error;
  }
}

function validNodeGrants(db: DatabaseSync, ownerNodeId: string, name: string): Array<{ nodeId: string; clusterId: string }> {
  const rows = db.prepare("SELECT node_id,cluster_id,owner_join_sequence,receiver_join_sequence FROM skill_node_shares WHERE name=? ORDER BY node_id").all(name) as unknown as Array<{node_id:string;cluster_id:string;owner_join_sequence:number;receiver_join_sequence:number}>;
  const owned = listSharingMemberships(db, ownerNodeId);
  return rows.filter((row) => owned.some((item) => item.clusterId === row.cluster_id && item.joinSequence === row.owner_join_sequence)
    && !getSharingCluster(db, row.cluster_id).closed
    && listSharingClusterMembers(db, row.cluster_id).some((member) => member.nodeId === row.node_id && member.joinSequence === row.receiver_join_sequence))
    .map((row) => ({ nodeId: row.node_id, clusterId: row.cluster_id }));
}

export function skillNodeIds(db: DatabaseSync, ownerNodeId: string, name: string): string[] {
  ensureSkillSharingSchema(db);
  validateSkillName(name);
  return validNodeGrants(db, ownerNodeId, name).map((grant) => grant.nodeId);
}

export function skillClusterIds(db: DatabaseSync, ownerNodeId: string, name: string): string[] {
  ensureSkillSharingSchema(db);
  validateSkillName(name);
  const rows = db.prepare("SELECT cluster_id,owner_join_sequence FROM skill_shares WHERE name=? ORDER BY cluster_id").all(name) as unknown as Array<{cluster_id:string;owner_join_sequence:number}>;
  const memberships = listSharingMemberships(db, ownerNodeId);
  return rows.filter((row) => memberships.some((item) => item.clusterId === row.cluster_id && item.joinSequence === row.owner_join_sequence)
    && !getSharingCluster(db, row.cluster_id).closed).map((row) => row.cluster_id);
}

export function authorizedSkillClusters(db: DatabaseSync, owner: string, receiver: string, name: string): string[] {
  const clusters = skillClusterIds(db, owner, name).filter((id) => listSharingClusterMembers(db, id).some((member) => member.nodeId === receiver));
  for (const grant of validNodeGrants(db, owner, name)) if (grant.nodeId === receiver && !clusters.includes(grant.clusterId)) clusters.push(grant.clusterId);
  return clusters;
}

export function listReceivedSkills(db: DatabaseSync): ReceivedSkill[] {
  ensureSkillSharingSchema(db);
  const rows = db.prepare("SELECT owner_node_id,name,digest,updated_at FROM received_skills ORDER BY name").all() as unknown as Array<{owner_node_id:string;name:string;digest:string;updated_at:string}>;
  return rows.map((row) => ({ ownerNodeId: row.owner_node_id, name: row.name, digest: row.digest, updatedAt: row.updated_at }));
}

export function listReceivedScopedSkills(db: DatabaseSync): ReceivedScopedSkill[] {
  ensureSkillSharingSchema(db);
  const rows = db.prepare("SELECT owner_node_id,name,digest,updated_at,project_ids,conversations FROM received_scoped_skills ORDER BY name").all() as unknown as Array<{owner_node_id:string;name:string;digest:string;updated_at:string;project_ids:string;conversations:string}>;
  return rows.map((row) => ({ ownerNodeId: row.owner_node_id, name: row.name, digest: row.digest, updatedAt: row.updated_at,
    projectIds: JSON.parse(row.project_ids) as string[], conversations: JSON.parse(row.conversations) as SkillConversationGrant[] }));
}

function forbidden(relative: string): boolean {
  const parts = relative.split("/");
  const leaf = parts.at(-1) ?? "";
  const directories = [".git", "node_modules", "logs", "cache", "caches", "dist", "build", "coverage", ".pytest_cache", "__pycache__"];
  return parts.some((part) => directories.includes(part)) || leaf === ".env" || leaf.startsWith(".env.")
    || [".npmrc", ".pypirc", ".netrc", "credentials.json"].includes(leaf)
    || /^service-account.*\.json$/i.test(leaf) || /^id_(rsa|ed25519|ecdsa)/.test(leaf)
    || /\.(pem|key|p12|pfx|log)$/i.test(leaf) || leaf.includes(".sync-conflict-");
}

function safeRelative(value: string): boolean {
  if (!value || value.length > 1024 || value.includes("\\") || path.posix.isAbsolute(value) || /^[a-z]:/i.test(value)) return false;
  return value.split("/").every((part) => part && part !== "." && part !== ".." && !part.includes(":") && !/[\0-\x1f\x7f]/.test(part));
}

function canonicalDecodedLength(content: string): number {
  if (content.length > Math.ceil(MAX_SKILL_BYTES / 3) * 4 + 4) throw new Error("Skill bundle exceeds limits");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) throw new Error("Invalid base64");
  return content.length / 4 * 3 - (content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0);
}

export function validateSkillBundle(value: unknown): SkillBundle {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join() !== "files") throw new Error("Invalid skill bundle");
  const files = (value as { files?: unknown }).files;
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_SKILL_FILES) throw new Error("Invalid skill bundle file count");
  const seen = new Set<string>();
  let bytes = 0;
  for (const raw of files) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid skill bundle file");
    if (Object.keys(raw).sort().join() !== "content,executable,path") throw new Error("Invalid skill bundle file");
    const file = raw as SkillBundleFile;
    const folded = typeof file.path === "string" ? file.path.normalize("NFC").toLocaleLowerCase("en-US") : "";
    if (typeof file.path !== "string" || !safeRelative(file.path) || forbidden(file.path) || seen.has(folded) || typeof file.content !== "string" || typeof file.executable !== "boolean") throw new Error("Invalid skill bundle file");
    for (const prior of seen) if (prior.startsWith(`${folded}/`) || folded.startsWith(`${prior}/`)) throw new Error("Skill bundle file/directory collision");
    bytes += canonicalDecodedLength(file.content);
    if (bytes > MAX_SKILL_BYTES) throw new Error("Skill bundle exceeds limits");
    if (Buffer.from(file.content, "base64").toString("base64") !== file.content) throw new Error("Invalid base64");
    seen.add(folded);
  }
  if (!seen.has("skill.md")) throw new Error("Skill bundle lacks SKILL.md");
  return value as SkillBundle;
}

function validateManifest(bundle: SkillBundle, name: string): void {
  const manifest = bundle.files.find((file) => file.path === "SKILL.md");
  if (!manifest) throw new Error("Skill bundle lacks canonical SKILL.md");
  const fields = parseResourceFrontmatter(Buffer.from(manifest.content, "base64").toString("utf8"));
  if (fields.name !== name || !fields.description?.trim()) throw new Error("Invalid SKILL.md metadata");
}

async function visitSkill(directory: string, files: SkillBundleFile[], size: { bytes: number }, relative = ""): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (forbidden(next)) continue;
    const full = path.join(directory, entry.name);
    const info = await lstat(full);
    if (info.isSymbolicLink()) throw new Error("Skill bundles cannot contain symbolic links");
    if (info.isDirectory()) await visitSkill(full, files, size, next);
    else if (info.isFile()) {
      if (files.length + 1 > MAX_SKILL_FILES || size.bytes + info.size > MAX_SKILL_BYTES) throw new Error("Skill bundle exceeds limits");
      const content = await readFile(full);
      size.bytes += content.length;
      if (size.bytes > MAX_SKILL_BYTES) throw new Error("Skill bundle exceeds limits");
      files.push({ path: next, content: content.toString("base64"), executable: Boolean(info.mode & 0o111) });
    } else throw new Error("Unsupported skill file type");
  }
}

export function skillBundleDigest(value: unknown): string {
  const bundle = validateSkillBundle(value);
  return createHash("sha256").update(JSON.stringify(bundle)).digest("hex");
}

export async function buildSkillBundle(root: string, name: string): Promise<{ bundle: SkillBundle; digest: string }> {
  validateSkillName(name);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("Skill root must be a real directory, not a symbolic link");
  const files: SkillBundleFile[] = [];
  await visitSkill(root, files, { bytes: 0 });
  const bundle = validateSkillBundle({ files: files.sort((left, right) => left.path.localeCompare(right.path)) });
  validateManifest(bundle, name);
  return { bundle, digest: skillBundleDigest(bundle) };
}

async function assertRealParent(destination: string): Promise<void> {
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  await realpath(parent);
  if (!(await lstat(parent)).isDirectory()) throw new Error("Skill destination parent is not a real directory");
}

export async function installSkillBundle(value: unknown, name: string, destination: string, stagingRoot: string): Promise<string> {
  const bundle = validateSkillBundle(value);
  validateSkillName(name);
  validateManifest(bundle, name);
  await assertRealParent(destination);
  const operation = path.join(stagingRoot, randomUUID());
  const staged = path.join(operation, name);
  const backup = path.join(operation, "previous");
  await mkdir(staged, { recursive: true });
  let movedOld = false;
  try {
    for (const file of bundle.files) {
      const target = path.join(staged, ...file.path.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(file.content, "base64"), { mode: file.executable ? 0o700 : 0o600 });
      if (file.executable) await chmod(target, 0o700);
    }
    try {
      const info = await lstat(destination);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Skill destination is not a real directory");
      await rename(destination, backup); movedOld = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try { await rename(staged, destination); }
    catch (error) {
      if (movedOld) {
        try { await rename(backup, destination); }
        catch (restoreError) { movedOld = false; throw new AggregateError([error, restoreError], `Skill restore failed; backup retained at ${backup}`); }
      }
      throw error;
    }
    movedOld = false;
    await rm(operation, { recursive: true, force: true });
    return skillBundleDigest(bundle);
  } catch (error) {
    // A failed restore retains the backup. Never delete the user's only old copy.
    await rm(staged, { recursive: true, force: true });
    throw error;
  }
}
