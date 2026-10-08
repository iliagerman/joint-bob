import { createHash } from "node:crypto";
import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { isTrustedTwin } from "../cluster-sharing-policy.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { ClusterV2HttpError } from "../cluster-v2-errors.js";
import { clearSecretAccountFiles, decryptSecretValue, encryptSecretValue, ensureSecretSchema, normalizeWebsiteOrigin } from "../secrets.js";
import { ensureSelectedSharingSchema } from "../selected-sharing.js";
import { mayShareProject, sharedProjectIds } from "./sharing-files.js";
import { replicationPeers, signedPeerPost } from "./replication-v2.js";
const scopeSchema = z.object({ type: z.enum(["workspace", "project", "conversation"]), id: z.string().min(1).max(300), projectIds: z.array(z.string().min(1).max(300)).min(1).max(1e4), clusterIds: z.array(z.string().uuid()).max(100).optional() }).strict();
const grantSchema = z.object({ clusterId: z.string().uuid(), nodeId: z.string().min(1).max(300).nullable() }).strict();
function ensureSecretSharingSchema(db) {
  ensureSchema(db);
  ensureSelectedSharingSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS cluster_v2_secret_grants(account_id TEXT NOT NULL,cluster_id TEXT NOT NULL,node_id TEXT NOT NULL DEFAULT '',PRIMARY KEY(account_id,cluster_id,node_id));
 CREATE TABLE IF NOT EXISTS cluster_v2_local_secret_assignments(scope_type TEXT NOT NULL,scope_id TEXT NOT NULL,account_id TEXT NOT NULL,PRIMARY KEY(scope_type,scope_id,account_id));`);
}
function secretGrants(db, local, id) {
  ensureSecretSharingSchema(db);
  const owner = db.prepare("SELECT origin_node_id FROM secret_accounts WHERE id=?").get(id);
  if (!owner) throw new ClusterV2HttpError(404, "Secret account not found");
  if (db.prepare("SELECT 1 FROM cluster_v2_scoped_secret_copies WHERE account_id=?").get(id) || owner.origin_node_id && owner.origin_node_id !== local) throw new ClusterV2HttpError(403, "Only the original node may share this secret");
  return db.prepare("SELECT cluster_id clusterId,NULLIF(node_id,'') nodeId FROM cluster_v2_secret_grants WHERE account_id=? ORDER BY cluster_id,node_id").all(id);
}
function setSecretGrants(db, local, id, input) {
  const grants = z.array(grantSchema).max(1e3).parse(input);
  secretGrants(db, local, id);
  const account = db.prepare("SELECT project_id FROM secret_accounts WHERE id=?").get(id);
  if (account.project_id && db.prepare("SELECT owner_node_id FROM cluster_v2_resource_policy WHERE kind='project' AND resource_id=? AND deleted=0").get(account.project_id)?.owner_node_id !== local) throw new ClusterV2HttpError(403, "Only the project owner may share its secret");
  const keys = /* @__PURE__ */ new Set();
  for (const grant of grants) {
    const key = `${grant.clusterId}:${grant.nodeId ?? ""}`;
    if (keys.has(key)) throw new ClusterV2HttpError(400, "Duplicate secret destination");
    keys.add(key);
    if (!db.prepare("SELECT 1 FROM sharing_memberships WHERE cluster_id=? AND node_id=?").get(grant.clusterId, local)) throw new ClusterV2HttpError(403, "Not a member of this cluster");
    if (grant.nodeId && (grant.nodeId === local || !db.prepare("SELECT 1 FROM sharing_memberships WHERE cluster_id=? AND node_id=?").get(grant.clusterId, grant.nodeId))) throw new ClusterV2HttpError(400, "Destination node is not in this cluster");
    if (account.project_id && !db.prepare("SELECT 1 FROM sharing_resource_shares WHERE kind='project' AND resource_id=? AND cluster_id=?").get(account.project_id, grant.clusterId)) throw new ClusterV2HttpError(403, "Share the owning project with this cluster first");
  }
  db.exec("SAVEPOINT secret_grants");
  try {
    db.prepare("DELETE FROM cluster_v2_secret_grants WHERE account_id=?").run(id);
    const insert = db.prepare("INSERT INTO cluster_v2_secret_grants VALUES(?,?,?)");
    for (const grant of grants) insert.run(id, grant.clusterId, grant.nodeId ?? "");
    db.exec("RELEASE secret_grants");
  } catch (error) {
    db.exec("ROLLBACK TO secret_grants; RELEASE secret_grants");
    throw error;
  }
  return secretGrants(db, local, id);
}
function activeGrants(db, local, peer, id) {
  return db.prepare(`SELECT g.cluster_id clusterId,NULLIF(g.node_id,'') nodeId FROM cluster_v2_secret_grants g
 JOIN sharing_memberships owner ON owner.cluster_id=g.cluster_id AND owner.node_id=?
 JOIN sharing_memberships target ON target.cluster_id=g.cluster_id AND target.node_id=?
 WHERE g.account_id=? AND (g.node_id='' OR g.node_id=?)`).all(local, peer, id, peer);
}
const websiteOriginSchema = z.string().max(2048).refine((value) => {
  try {
    return normalizeWebsiteOrigin(value) === value;
  } catch {
    return false;
  }
}, "Website origin is invalid");
const accountSchema = z.object({ id: z.string().uuid(), label: z.string().trim().min(1).max(64), provider: z.enum(["aws", "google", "github", "stripe", "cloudflare", "openai", "zai", "grafana", "datadog", "postgres", "mssql", "mongodb", "custom", "website"]), websiteOrigin: websiteOriginSchema.optional(), variables: z.array(z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), kind: z.enum(["value", "file"]), value: z.string().max(1e5) }).strict()).min(1).max(20), scopes: z.array(scopeSchema).max(1e3), grants: z.array(grantSchema).max(1e3).default([]), projectId: z.string().min(1).max(300).optional(), updatedAt: z.string().datetime() }).strict().refine((account) => account.provider !== "website" || account.websiteOrigin !== void 0, "Website secret accounts require a website origin").refine((account) => account.websiteOrigin === void 0 || account.variables.every((variable) => variable.kind === "value"), "Website credential accounts cannot contain file variables");
const scopedCredentialSchema = z.object({ accounts: z.array(accountSchema).max(1e4) }).strict();
function ensureSchema(db) {
  ensureSecretSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS cluster_v2_scoped_secret_copies(peer_id TEXT NOT NULL,account_id TEXT PRIMARY KEY,scopes TEXT NOT NULL,payload_hash TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS cluster_v2_scoped_secret_errors(peer_id TEXT PRIMARY KEY,error TEXT NOT NULL);`);
  const columns = db.prepare("PRAGMA table_info(cluster_v2_scoped_secret_copies)").all();
  if (!columns.some((column) => column.name === "grants")) db.exec("ALTER TABLE cluster_v2_scoped_secret_copies ADD COLUMN grants TEXT NOT NULL DEFAULT '[]'");
}
function scopesForAccount(db, local, accountId, allowed) {
  const rows = db.prepare("SELECT scope_type,scope_id FROM secret_assignments WHERE account_id=?").all(accountId);
  return rows.flatMap((row) => {
    const projects = row.scope_type === "project" ? [{ id: row.scope_id }] : row.scope_type === "workspace" ? db.prepare("SELECT id FROM projects WHERE workspace_id=?").all(row.scope_id) : db.prepare("SELECT DISTINCT project_id id FROM conversation_records WHERE engine||':'||session_id=?").all(row.scope_id);
    const projectIds = projects.map((project) => project.id).filter((id) => allowed.includes(id));
    if (!projectIds.length) return [];
    const mirror = row.scope_type === "workspace" ? db.prepare("SELECT owner_node_id FROM cluster_v2_shared_workspaces WHERE workspace_id=?").get(row.scope_id) : void 0;
    if (mirror && mirror.owner_node_id !== local && !isTrustedTwin(db, local, mirror.owner_node_id)) return projectIds.map((id) => ({ type: "project", id, projectIds: [id] }));
    return [{ type: row.scope_type, id: row.scope_id, projectIds }];
  });
}
function snapshot(db, local, peer) {
  const allowed = sharedProjectIds(db, local, peer);
  ensureSecretSharingSchema(db);
  const rows = db.prepare(`SELECT id,label,provider,website_origin,variables_encrypted,updated_at,replicate,project_id FROM secret_accounts a WHERE (replicate=1 OR EXISTS(SELECT 1 FROM cluster_v2_secret_grants g WHERE g.account_id=a.id) OR EXISTS(SELECT 1 FROM secret_assignments s JOIN cluster_v2_share_selections sh ON sh.kind='workspace' AND sh.resource_id=s.scope_id WHERE s.account_id=a.id AND s.scope_type='workspace'))
  AND (origin_node_id='' OR origin_node_id=?)
  AND NOT EXISTS(SELECT 1 FROM cluster_v2_scoped_secret_copies c WHERE c.account_id=a.id)`).all(local);
  return rows.flatMap((row) => {
    const grants = activeGrants(db, local, peer, row.id).filter((grant) => !row.project_id || Boolean(db.prepare("SELECT 1 FROM sharing_resource_shares WHERE kind='project' AND resource_id=? AND cluster_id=?").get(row.project_id, grant.clusterId)));
    if (row.project_id && (!grants.length || !allowed.includes(row.project_id))) return [];
    const scopes = scopesForAccount(db, local, row.id, allowed).map((scope) => {
      const clusterIds = db.prepare(`SELECT DISTINCT sh.cluster_id id FROM sharing_resource_shares sh
    JOIN sharing_memberships owner ON owner.cluster_id=sh.cluster_id AND owner.node_id=?
    JOIN sharing_memberships target ON target.cluster_id=sh.cluster_id AND target.node_id=?
    WHERE sh.kind='project' AND sh.resource_id IN (${scope.projectIds.map(() => "?").join(",")})`).all(local, peer, ...scope.projectIds).map((item) => item.id).filter((clusterId) => row.replicate === 1 || grants.length > 0 || scope.type === "workspace" && Boolean(db.prepare("SELECT 1 FROM cluster_v2_share_selections WHERE kind='workspace' AND resource_id=? AND cluster_id=?").get(scope.id, clusterId)));
      return { ...scope, clusterIds };
    }).filter((scope) => row.replicate === 1 || grants.length > 0 || scope.type === "workspace" && scope.clusterIds.length > 0);
    return scopes.length || grants.length ? [accountSchema.parse({ id: row.id, label: row.label, provider: row.provider, ...row.website_origin ? { websiteOrigin: row.website_origin } : {}, variables: JSON.parse(decryptSecretValue(row.variables_encrypted)), updatedAt: row.updated_at, scopes, grants, ...row.project_id ? { projectId: row.project_id } : {} })] : [];
  });
}
function localScope(db, peer, scope) {
  if (scope.type !== "workspace") return scope.id;
  const mapping = db.prepare("SELECT workspace_id FROM cluster_v2_shared_workspaces WHERE owner_node_id=? AND source_workspace_id=?").get(peer, scope.id);
  if (!mapping) throw new ClusterV2HttpError(409, "Shared workspace metadata has not arrived");
  return mapping.workspace_id;
}
function removeCopy(db, peer, id) {
  if (!db.prepare("SELECT 1 FROM cluster_v2_scoped_secret_copies WHERE peer_id=? AND account_id=?").get(peer, id)) return;
  db.prepare("DELETE FROM secret_assignments WHERE account_id=?").run(id);
  db.prepare("DELETE FROM cluster_v2_local_secret_assignments WHERE account_id=?").run(id);
  db.prepare("DELETE FROM secret_accounts WHERE id=?").run(id);
  db.prepare("DELETE FROM cluster_v2_scoped_secret_copies WHERE peer_id=? AND account_id=?").run(peer, id);
  clearSecretAccountFiles(id);
}
function applyAccount(db, local, peer, account) {
  if (account.projectId) {
    const projectId = account.projectId;
    const policy = db.prepare("SELECT owner_node_id FROM cluster_v2_resource_policy WHERE kind='project' AND resource_id=? AND deleted=0").get(projectId);
    if (policy?.owner_node_id !== peer || !mayShareProject(db, local, peer, projectId) || !account.scopes.some((scope) => scope.type === "project" && scope.id === projectId)) throw new ClusterV2HttpError(403, "Credential owner project is not shared");
    if (account.grants.some((grant) => !db.prepare("SELECT 1 FROM sharing_resource_shares WHERE kind='project' AND resource_id=? AND cluster_id=?").get(projectId, grant.clusterId))) throw new ClusterV2HttpError(403, "Credential destination cannot access its project");
  }
  for (const grant of account.grants) if (!db.prepare("SELECT 1 FROM sharing_memberships a JOIN sharing_memberships b ON a.cluster_id=b.cluster_id WHERE a.cluster_id=? AND a.node_id=? AND b.node_id=?").get(grant.clusterId, local, peer) || grant.nodeId && grant.nodeId !== local) throw new ClusterV2HttpError(403, "Credential destination is not authorized");
  if (!account.scopes.length && !account.grants.length) throw new ClusterV2HttpError(403, "Credential has no authorized scope");
  for (const scope of account.scopes) if (scope.projectIds.some((id) => !mayShareProject(db, local, peer, id))) throw new ClusterV2HttpError(403, "Credential project is not shared");
  const copy = db.prepare("SELECT peer_id,payload_hash FROM cluster_v2_scoped_secret_copies WHERE account_id=?").get(account.id);
  const existing = db.prepare("SELECT origin_node_id FROM secret_accounts WHERE id=?").get(account.id);
  if (copy && copy.peer_id !== peer || existing && existing.origin_node_id !== peer) throw new ClusterV2HttpError(409, "Credential identity belongs to another source");
  const hash = createHash("sha256").update(JSON.stringify(account)).digest("hex");
  if (copy?.payload_hash === hash) return;
  const scopes = account.scopes.map((scope) => ({ type: scope.type, id: localScope(db, peer, scope) }));
  for (const [index, scope] of scopes.entries()) {
    if (scope.type === "project" && !account.scopes[index].projectIds.includes(scope.id)) throw new ClusterV2HttpError(403, "Invalid project credential scope");
    if (scope.type === "workspace" && account.scopes[index].projectIds.some((id) => !db.prepare("SELECT 1 FROM projects WHERE id=? AND workspace_id=?").get(id, scope.id))) throw new ClusterV2HttpError(403, "Invalid workspace credential scope");
    if (scope.type === "conversation" && !account.scopes[index].projectIds.some((id) => db.prepare("SELECT 1 FROM conversation_records WHERE project_id=? AND engine||':'||session_id=?").get(id, scope.id))) throw new ClusterV2HttpError(403, "Invalid conversation credential scope");
  }
  db.prepare(`INSERT INTO secret_accounts(id,label,provider,variables_encrypted,replicate,website_origin,origin_node_id,project_id,created_at,updated_at) VALUES(?,?,?,?,0,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET label=excluded.label,provider=excluded.provider,variables_encrypted=excluded.variables_encrypted,replicate=0,website_origin=excluded.website_origin,project_id=excluded.project_id,updated_at=excluded.updated_at`).run(account.id, account.label, account.provider, encryptSecretValue(JSON.stringify(account.variables)), account.websiteOrigin ?? null, peer, account.projectId ?? null, account.updatedAt, account.updatedAt);
  db.prepare("DELETE FROM secret_assignments WHERE account_id=?").run(account.id);
  for (const scope of scopes) db.prepare("INSERT OR IGNORE INTO secret_assignments VALUES(?,?,?)").run(scope.type, scope.id, account.id);
  if (account.grants.length) for (const row of db.prepare("SELECT scope_type,scope_id FROM cluster_v2_local_secret_assignments WHERE account_id=?").all(account.id)) db.prepare("INSERT OR IGNORE INTO secret_assignments VALUES(?,?,?)").run(row.scope_type, row.scope_id, account.id);
  else db.prepare("DELETE FROM cluster_v2_local_secret_assignments WHERE account_id=?").run(account.id);
  db.prepare("INSERT OR REPLACE INTO cluster_v2_scoped_secret_copies(peer_id,account_id,scopes,payload_hash,grants) VALUES(?,?,?,?,?)").run(peer, account.id, JSON.stringify(account.scopes), hash, JSON.stringify(account.grants));
}
async function receiveScopedCredentials(peer, input) {
  const payload = scopedCredentialSchema.parse(input), db = await clusterV2Database(), local = await getClusterNode();
  ensureSecretSharingSchema(db);
  if (!replicationPeers(db, local.id).some((row) => row.nodeId === peer)) throw new ClusterV2HttpError(403, "Forbidden");
  db.exec("SAVEPOINT scoped_credentials");
  try {
    for (const account of payload.accounts) applyAccount(db, local.id, peer, account);
    const previous = db.prepare("SELECT account_id FROM cluster_v2_scoped_secret_copies WHERE peer_id=?").all(peer);
    for (const row of previous) if (!payload.accounts.some((account) => account.id === row.account_id)) removeCopy(db, peer, row.account_id);
    db.exec("RELEASE scoped_credentials");
  } catch (error) {
    db.exec("ROLLBACK TO scoped_credentials; RELEASE scoped_credentials");
    throw error;
  }
}
async function flushScopedCredentials() {
  const db = await clusterV2Database(), local = await getClusterNode();
  ensureSecretSharingSchema(db);
  const copies = db.prepare("SELECT c.peer_id,c.account_id,c.scopes,c.grants,a.project_id FROM cluster_v2_scoped_secret_copies c JOIN secret_accounts a ON a.id=c.account_id").all();
  for (const copy of copies) {
    const scopes = z.array(scopeSchema).parse(JSON.parse(copy.scopes)), grants = z.array(grantSchema).parse(JSON.parse(copy.grants));
    const active = grants.some((grant) => db.prepare("SELECT 1 FROM sharing_memberships a JOIN sharing_memberships b ON a.cluster_id=b.cluster_id WHERE a.cluster_id=? AND a.node_id=? AND b.node_id=?").get(grant.clusterId, local.id, copy.peer_id) && (!copy.project_id || db.prepare("SELECT 1 FROM sharing_resource_shares WHERE kind='project' AND resource_id=? AND cluster_id=?").get(copy.project_id, grant.clusterId)));
    if (!active && (copy.project_id || scopes.every((scope) => scope.projectIds.every((id) => !mayShareProject(db, local.id, copy.peer_id, id))))) removeCopy(db, copy.peer_id, copy.account_id);
  }
  for (const peer of replicationPeers(db, local.id)) {
    const twin = isTrustedTwin(db, local.id, peer.nodeId);
    const accounts = snapshot(db, local.id, peer.nodeId).filter((account) => !twin || db.prepare("SELECT replicate FROM secret_accounts WHERE id=?").get(account.id).replicate === 0);
    try {
      await signedPeerPost(peer, "/api/cluster/v2/credentials/scoped", { accounts });
      db.prepare("DELETE FROM cluster_v2_scoped_secret_errors WHERE peer_id=?").run(peer.nodeId);
    } catch (error) {
      db.prepare("INSERT OR REPLACE INTO cluster_v2_scoped_secret_errors VALUES(?,?)").run(peer.nodeId, error instanceof Error ? error.message : "Scoped credentials failed");
    }
  }
}
export {
  ensureSecretSharingSchema,
  flushScopedCredentials,
  receiveScopedCredentials,
  scopedCredentialSchema,
  secretGrants,
  setSecretGrants
};
