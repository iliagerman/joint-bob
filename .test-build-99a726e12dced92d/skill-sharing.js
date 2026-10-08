import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getSharingCluster, listSharingClusterMembers, listSharingMemberships } from "./cluster-sharing-policy.js";
import { parseResourceFrontmatter } from "./skills.js";
const MAX_SKILL_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_FILES = 512;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const skillName = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/;
const conversationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,299}$/;
function validateSkillName(name) {
  if (!skillName.test(name) || name === "." || name === "..") throw new Error("Invalid skill name");
}
function validateUuid(value) {
  if (!uuid.test(value)) throw new Error("Invalid cluster ID");
}
function ensureSkillSharingSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS skill_shares(name TEXT NOT NULL,cluster_id TEXT NOT NULL,owner_join_sequence INTEGER NOT NULL,PRIMARY KEY(name,cluster_id));
CREATE TABLE IF NOT EXISTS received_skills(owner_node_id TEXT NOT NULL,name TEXT NOT NULL,digest TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner_node_id,name),UNIQUE(name));
CREATE TABLE IF NOT EXISTS skill_peer_status(owner_node_id TEXT PRIMARY KEY,last_success TEXT,last_error TEXT);
CREATE TABLE IF NOT EXISTS skill_node_shares(name TEXT NOT NULL,node_id TEXT NOT NULL,cluster_id TEXT NOT NULL,owner_join_sequence INTEGER NOT NULL,receiver_join_sequence INTEGER NOT NULL,PRIMARY KEY(name,node_id));
CREATE TABLE IF NOT EXISTS skill_scope_shares(name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('workspace','conversation')),target_id TEXT NOT NULL,project_id TEXT NOT NULL DEFAULT '',PRIMARY KEY(name,kind,target_id,project_id));
CREATE TABLE IF NOT EXISTS received_scoped_skills(owner_node_id TEXT NOT NULL,name TEXT NOT NULL,digest TEXT NOT NULL,updated_at TEXT NOT NULL,project_ids TEXT NOT NULL,conversations TEXT NOT NULL,PRIMARY KEY(owner_node_id,name),UNIQUE(name));`);
}
function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function validateScopes(db, scopes) {
  if (new Set(scopes.workspaceIds).size !== scopes.workspaceIds.length) throw new Error("Duplicate workspace selection");
  const conversationKeys = scopes.conversations.map((item) => `${item.projectId}\0${item.conversationId}`);
  if (new Set(conversationKeys).size !== conversationKeys.length) throw new Error("Duplicate conversation selection");
  const received = hasTable(db, "cluster_v2_project_workspaces") ? db.prepare("SELECT 1 FROM cluster_v2_project_workspaces WHERE workspace_id=?") : void 0;
  for (const workspaceId of scopes.workspaceIds) {
    if (!db.prepare("SELECT 1 FROM workspaces WHERE id=?").get(workspaceId) || received?.get(workspaceId)) throw new Error("Workspace is not on this node");
  }
  for (const { projectId, conversationId } of scopes.conversations) {
    if (!conversationIdPattern.test(conversationId)) throw new Error("Invalid conversation ID");
    if (!db.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId)) throw new Error("Conversation's project is not on this node");
  }
}
function skillScopeGrants(db, name) {
  ensureSkillSharingSchema(db);
  validateSkillName(name);
  const rows = db.prepare("SELECT kind,target_id,project_id FROM skill_scope_shares WHERE name=? ORDER BY kind,project_id,target_id").all(name);
  return {
    workspaceIds: rows.filter((row) => row.kind === "workspace").map((row) => row.target_id),
    conversations: rows.filter((row) => row.kind === "conversation").map((row) => ({ projectId: row.project_id, conversationId: row.target_id }))
  };
}
function setSkillShares(db, ownerNodeId, name, clusterIds, nodeIds = [], scopes = { workspaceIds: [], conversations: [] }) {
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
function validNodeGrants(db, ownerNodeId, name) {
  const rows = db.prepare("SELECT node_id,cluster_id,owner_join_sequence,receiver_join_sequence FROM skill_node_shares WHERE name=? ORDER BY node_id").all(name);
  const owned = listSharingMemberships(db, ownerNodeId);
  return rows.filter((row) => owned.some((item) => item.clusterId === row.cluster_id && item.joinSequence === row.owner_join_sequence) && !getSharingCluster(db, row.cluster_id).closed && listSharingClusterMembers(db, row.cluster_id).some((member) => member.nodeId === row.node_id && member.joinSequence === row.receiver_join_sequence)).map((row) => ({ nodeId: row.node_id, clusterId: row.cluster_id }));
}
function skillNodeIds(db, ownerNodeId, name) {
  ensureSkillSharingSchema(db);
  validateSkillName(name);
  return validNodeGrants(db, ownerNodeId, name).map((grant) => grant.nodeId);
}
function skillClusterIds(db, ownerNodeId, name) {
  ensureSkillSharingSchema(db);
  validateSkillName(name);
  const rows = db.prepare("SELECT cluster_id,owner_join_sequence FROM skill_shares WHERE name=? ORDER BY cluster_id").all(name);
  const memberships = listSharingMemberships(db, ownerNodeId);
  return rows.filter((row) => memberships.some((item) => item.clusterId === row.cluster_id && item.joinSequence === row.owner_join_sequence) && !getSharingCluster(db, row.cluster_id).closed).map((row) => row.cluster_id);
}
function authorizedSkillClusters(db, owner, receiver, name) {
  const clusters = skillClusterIds(db, owner, name).filter((id) => listSharingClusterMembers(db, id).some((member) => member.nodeId === receiver));
  for (const grant of validNodeGrants(db, owner, name)) if (grant.nodeId === receiver && !clusters.includes(grant.clusterId)) clusters.push(grant.clusterId);
  return clusters;
}
function listReceivedSkills(db) {
  ensureSkillSharingSchema(db);
  const rows = db.prepare("SELECT owner_node_id,name,digest,updated_at FROM received_skills ORDER BY name").all();
  return rows.map((row) => ({ ownerNodeId: row.owner_node_id, name: row.name, digest: row.digest, updatedAt: row.updated_at }));
}
function listReceivedScopedSkills(db) {
  ensureSkillSharingSchema(db);
  const rows = db.prepare("SELECT owner_node_id,name,digest,updated_at,project_ids,conversations FROM received_scoped_skills ORDER BY name").all();
  return rows.map((row) => ({
    ownerNodeId: row.owner_node_id,
    name: row.name,
    digest: row.digest,
    updatedAt: row.updated_at,
    projectIds: JSON.parse(row.project_ids),
    conversations: JSON.parse(row.conversations)
  }));
}
function forbidden(relative) {
  const parts = relative.split("/");
  const leaf = parts.at(-1) ?? "";
  const directories = [".git", "node_modules", "logs", "cache", "caches", "dist", "build", "coverage", ".pytest_cache", "__pycache__"];
  return parts.some((part) => directories.includes(part)) || leaf === ".env" || leaf.startsWith(".env.") || [".npmrc", ".pypirc", ".netrc", "credentials.json"].includes(leaf) || /^service-account.*\.json$/i.test(leaf) || /^id_(rsa|ed25519|ecdsa)/.test(leaf) || /\.(pem|key|p12|pfx|log)$/i.test(leaf) || leaf.includes(".sync-conflict-");
}
function safeRelative(value) {
  if (!value || value.length > 1024 || value.includes("\\") || path.posix.isAbsolute(value) || /^[a-z]:/i.test(value)) return false;
  return value.split("/").every((part) => part && part !== "." && part !== ".." && !part.includes(":") && !/[\0-\x1f\x7f]/.test(part));
}
function canonicalDecodedLength(content) {
  if (content.length > Math.ceil(MAX_SKILL_BYTES / 3) * 4 + 4) throw new Error("Skill bundle exceeds limits");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) throw new Error("Invalid base64");
  return content.length / 4 * 3 - (content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0);
}
function validateSkillBundle(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join() !== "files") throw new Error("Invalid skill bundle");
  const files = value.files;
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_SKILL_FILES) throw new Error("Invalid skill bundle file count");
  const seen = /* @__PURE__ */ new Set();
  let bytes = 0;
  for (const raw of files) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid skill bundle file");
    if (Object.keys(raw).sort().join() !== "content,executable,path") throw new Error("Invalid skill bundle file");
    const file = raw;
    const folded = typeof file.path === "string" ? file.path.normalize("NFC").toLocaleLowerCase("en-US") : "";
    if (typeof file.path !== "string" || !safeRelative(file.path) || forbidden(file.path) || seen.has(folded) || typeof file.content !== "string" || typeof file.executable !== "boolean") throw new Error("Invalid skill bundle file");
    for (const prior of seen) if (prior.startsWith(`${folded}/`) || folded.startsWith(`${prior}/`)) throw new Error("Skill bundle file/directory collision");
    bytes += canonicalDecodedLength(file.content);
    if (bytes > MAX_SKILL_BYTES) throw new Error("Skill bundle exceeds limits");
    if (Buffer.from(file.content, "base64").toString("base64") !== file.content) throw new Error("Invalid base64");
    seen.add(folded);
  }
  if (!seen.has("skill.md")) throw new Error("Skill bundle lacks SKILL.md");
  return value;
}
function validateManifest(bundle, name) {
  const manifest = bundle.files.find((file) => file.path === "SKILL.md");
  if (!manifest) throw new Error("Skill bundle lacks canonical SKILL.md");
  const fields = parseResourceFrontmatter(Buffer.from(manifest.content, "base64").toString("utf8"));
  if (fields.name !== name || !fields.description?.trim()) throw new Error("Invalid SKILL.md metadata");
}
async function visitSkill(directory, files, size, relative = "") {
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
      files.push({ path: next, content: content.toString("base64"), executable: Boolean(info.mode & 73) });
    } else throw new Error("Unsupported skill file type");
  }
}
function skillBundleDigest(value) {
  const bundle = validateSkillBundle(value);
  return createHash("sha256").update(JSON.stringify(bundle)).digest("hex");
}
async function buildSkillBundle(root, name) {
  validateSkillName(name);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("Skill root must be a real directory, not a symbolic link");
  const files = [];
  await visitSkill(root, files, { bytes: 0 });
  const bundle = validateSkillBundle({ files: files.sort((left, right) => left.path.localeCompare(right.path)) });
  validateManifest(bundle, name);
  return { bundle, digest: skillBundleDigest(bundle) };
}
async function assertRealParent(destination) {
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  await realpath(parent);
  if (!(await lstat(parent)).isDirectory()) throw new Error("Skill destination parent is not a real directory");
}
async function installSkillBundle(value, name, destination, stagingRoot) {
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
      await writeFile(target, Buffer.from(file.content, "base64"), { mode: file.executable ? 448 : 384 });
      if (file.executable) await chmod(target, 448);
    }
    try {
      const info = await lstat(destination);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Skill destination is not a real directory");
      await rename(destination, backup);
      movedOld = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await rename(staged, destination);
    } catch (error) {
      if (movedOld) {
        try {
          await rename(backup, destination);
        } catch (restoreError) {
          movedOld = false;
          throw new AggregateError([error, restoreError], `Skill restore failed; backup retained at ${backup}`);
        }
      }
      throw error;
    }
    movedOld = false;
    await rm(operation, { recursive: true, force: true });
    return skillBundleDigest(bundle);
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    throw error;
  }
}
export {
  MAX_SKILL_BYTES,
  MAX_SKILL_FILES,
  authorizedSkillClusters,
  buildSkillBundle,
  ensureSkillSharingSchema,
  installSkillBundle,
  listReceivedScopedSkills,
  listReceivedSkills,
  setSkillShares,
  skillBundleDigest,
  skillClusterIds,
  skillNodeIds,
  skillScopeGrants,
  validateSkillBundle,
  validateSkillName
};
