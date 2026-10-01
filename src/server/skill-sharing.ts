import { lstat, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Request, Response as HttpResponse, NextFunction } from "express";
import { z } from "zod";
import { AGENT_RESOURCES_FOLDER_ID, agentResourcePaths } from "../agent-resources.js";
import { getClusterNode } from "../cluster.js";
import { isTrustedTwin, listSharingClusterMembers, listSharingMemberships, getSharingCluster } from "../cluster-sharing-policy.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { resolveDataDirectory } from "../data-directory.js";
import { signClusterRequest } from "../cluster-protocol.js";
import { getSettings } from "../settings.js";
import { pauseSyncthingFolders } from "../syncthing.js";
import { authorizedSkillClusters, buildSkillBundle, ensureSkillSharingSchema, installSkillBundle, listReceivedScopedSkills, listReceivedSkills, setSkillShares, skillBundleDigest, skillClusterIds, skillNodeIds, skillScopeGrants, validateSkillName, type ReceivedScopedSkill, type ReceivedSkill, type SkillConversationGrant, type SkillScopeGrants } from "../skill-sharing.js";
import { backupRemovedSkill, markReceived, receivedOwner, skillSuppressed, suppressSkill, unlinkSkillAliases, unmarkReceived, withSkillMutation } from "../skill-sharing-files.js";
import { ensureResourceSharingSchema } from "../cluster-sharing.js";
import { scopedSkillDirectory, scopedSkillParent, writeScopedSkillIndex } from "../scoped-skills.js";
import { mayShareProject } from "./sharing-files.js";
import { sendError } from "./http-auth.js";
import { app } from "./state.js";

const nameSchema = z.string().min(1).max(200).refine((value) => { try { validateSkillName(value); return true; } catch { return false; } });
const conversationGrantSchema = z.object({ projectId: z.string().min(1).max(200), conversationId: z.string().min(1).max(300) }).strict();
const selectionSchema = z.object({
  clusterIds: z.array(z.string().uuid()).max(100),
  nodeIds: z.array(z.string().uuid()).max(100).default([]),
  workspaceIds: z.array(z.string().min(1).max(300)).max(100).default([]),
  conversations: z.array(conversationGrantSchema).max(200).default([]),
}).strict();
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const manifestSchema = z.object({ ownerNodeId: z.string().uuid(), skills: z.array(z.object({ name: nameSchema, digest: digestSchema }).strict()).max(512) }).strict()
  .refine((value) => new Set(value.skills.map((skill) => skill.name.toLowerCase())).size === value.skills.length, "Duplicate skill names");
const scopedManifestSchema = z.object({ ownerNodeId: z.string().uuid(), skills: z.array(z.object({ name: nameSchema, digest: digestSchema,
  projectIds: z.array(z.string().min(1).max(200)).max(500), conversations: z.array(conversationGrantSchema).max(500) }).strict()).max(512) }).strict()
  .refine((value) => new Set(value.skills.map((skill) => skill.name.toLowerCase())).size === value.skills.length, "Duplicate skill names");
const bundleReplySchema = z.object({ name: nameSchema, digest: digestSchema, bundle: z.unknown() }).strict();
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_BUNDLE_RESPONSE_BYTES = 4 * 1024 * 1024;
let legacyStatus: { verified: boolean; error: string | null } = { verified: false, error: null };
let refresh: Promise<void> | undefined;

function failure(message: string, status = 409): Error { return Object.assign(new Error(message), { status }); }
export async function ensureLegacySkillSyncPaused(): Promise<void> {
  try {
    await pauseSyncthingFolders([AGENT_RESOURCES_FOLDER_ID]);
    legacyStatus = { verified: true, error: null };
  } catch (error) {
    legacyStatus = { verified: false, error: (error as Error).message };
    throw failure(`Cannot verify legacy skill sync is paused: ${legacyStatus.error}`, 503);
  }
}

function commonClusters(db: DatabaseSync, local: string, peer: string): string[] {
  return listSharingMemberships(db, local).map((membership) => membership.clusterId).filter((id) =>
    !getSharingCluster(db, id).closed && listSharingClusterMembers(db, id).some((member) => member.nodeId === peer));
}
function requirePeer(db: DatabaseSync, local: string, peer: string, clusterId?: string): string {
  const clusters = commonClusters(db, local, peer);
  const id = clusterId ? clusters.find((candidate) => candidate === clusterId) : clusters[0];
  if (!id) throw failure("Forbidden", 403);
  return id;
}

async function existing(directory: string): Promise<boolean> {
  try { await lstat(directory); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function managedNames(): Promise<string[]> {
  const root = agentResourcePaths().sharedSkills;
  if (!await existing(root)) return [];
  if (!(await lstat(root)).isDirectory()) throw failure("Managed skills root must be a real directory");
  const names: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (!await existing(path.join(root, entry.name, "SKILL.md"))) continue;
    if (!await skillSuppressed(root, entry.name)) names.push(entry.name);
  }
  return names.sort();
}
function aliasRoots(): string[] {
  const settings = getSettings();
  return [path.join(os.homedir(), ".agents/skills"), path.join(settings.pi.configPath, "skills"), path.join(settings.claude.configPath, "skills")];
}
async function removeReceived(db: DatabaseSync, prior: ReceivedSkill): Promise<void> {
  const destination = path.join(agentResourcePaths().sharedSkills, prior.name);
  if (await existing(destination)) {
    if ((await buildSkillBundle(destination, prior.name)).digest !== prior.digest) throw failure(`Modified received skill preserved: ${prior.name}`);
    await backupRemovedSkill(destination);
  }
  await unlinkSkillAliases(destination, aliasRoots());
  await unmarkReceived(agentResourcePaths().sharedSkills, prior.name);
  db.prepare("DELETE FROM received_skills WHERE owner_node_id=? AND name=?").run(prior.ownerNodeId, prior.name);
}

async function localView() {
  const db = await clusterV2Database(), node = await getClusterNode();
  ensureSkillSharingSchema(db);
  const received = listReceivedSkills(db);
  const nodeName = db.prepare("SELECT name FROM cluster_v2_membership_nodes WHERE cluster_id=? AND node_id=?");
  const nodes = new Map<string, { nodeId: string; name: string; twin: boolean; clusterIds: string[] }>();
  const clusters = listSharingMemberships(db, node.id).map((membership) => getSharingCluster(db, membership.clusterId)).filter((cluster) => !cluster.closed).map((cluster) => {
    const members = listSharingClusterMembers(db, cluster.id).filter((member) => member.nodeId !== node.id).map((member) => {
      const name = (nodeName.get(cluster.id, member.nodeId) as { name: string | null } | undefined)?.name || member.nodeId;
      const known = nodes.get(member.nodeId) ?? { nodeId: member.nodeId, name, twin: isTrustedTwin(db, node.id, member.nodeId), clusterIds: [] };
      known.clusterIds.push(cluster.id);
      nodes.set(member.nodeId, known);
      return { nodeId: member.nodeId, name };
    });
    return { ...cluster, members };
  });
  const skills = [];
  for (const name of await managedNames()) {
    const source = received.find((item) => item.name === name);
    const owner = source?.ownerNodeId ?? await receivedOwner(agentResourcePaths().sharedSkills, name);
    const scopes = owner ? { workspaceIds: [], conversations: [] } : skillScopeGrants(db, name);
    skills.push({ name, path: await realpath(path.join(agentResourcePaths().sharedSkills, name)), kind: owner ? "received" : "local",
      clusterIds: owner ? [] : skillClusterIds(db, node.id, name), nodeIds: owner ? [] : skillNodeIds(db, node.id, name), ...scopes,
      receivedFrom: owner, receivedFromName: owner ? nodes.get(owner)?.name ?? owner : null, lastSync: source?.updatedAt });
  }
  const peerStatus = (db.prepare("SELECT owner_node_id AS ownerNodeId,last_success AS lastSuccess,last_error AS error FROM skill_peer_status").all() as Array<{ ownerNodeId: string; lastSuccess: string | null; error: string | null }>)
    .map((status) => ({ ...status, ownerName: nodes.get(status.ownerNodeId)?.name ?? status.ownerNodeId }));
  // Workspaces this node owns; a received "Shared projects" workspace belongs to its owner.
  const registry = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cluster_v2_project_workspaces'").get();
  const workspaces = db.prepare(`SELECT w.id,w.label FROM workspaces w${registry ? " WHERE NOT EXISTS (SELECT 1 FROM cluster_v2_project_workspaces r WHERE r.workspace_id=w.id)" : ""} ORDER BY w.label,w.id`).all() as Array<{ id: string; label: string }>;
  return { clusters, nodes: [...nodes.values()].sort((left, right) => left.name.localeCompare(right.name)), workspaces, legacy: legacyStatus, skills, peerStatus };
}

/** Where a receiver may load a skill when no cluster or node grant gives it the whole skill. */
function scopedGrantFor(db: DatabaseSync, owner: string, receiver: string, name: string): { projectIds: string[]; conversations: SkillConversationGrant[] } {
  const scopes = skillScopeGrants(db, name);
  if (!scopes.workspaceIds.length && !scopes.conversations.length) return { projectIds: [], conversations: [] };
  ensureResourceSharingSchema(db);
  const shared = (projectId: string) => mayShareProject(db, owner, receiver, projectId);
  const projectIds = new Set<string>();
  const inWorkspace = db.prepare("SELECT id FROM projects WHERE workspace_id=? ORDER BY id");
  for (const workspaceId of scopes.workspaceIds) {
    for (const { id } of inWorkspace.all(workspaceId) as Array<{ id: string }>) if (shared(id)) projectIds.add(id);
  }
  const conversations = scopes.conversations.filter((item) => !projectIds.has(item.projectId) && shared(item.projectId));
  return { projectIds: [...projectIds], conversations };
}
function scopedOnly(db: DatabaseSync, owner: string, receiver: string, name: string) {
  if (authorizedSkillClusters(db, owner, receiver, name).length) return undefined;
  const grant = scopedGrantFor(db, owner, receiver, name);
  return grant.projectIds.length || grant.conversations.length ? grant : undefined;
}

async function scopedManifestFor(receiver: string) {
  const db = await clusterV2Database(), owner = (await getClusterNode()).id;
  requirePeer(db, owner, receiver);
  await ensureLegacySkillSyncPaused();
  return withSkillMutation(async () => {
    const skills = [];
    for (const name of await managedNames()) {
      if (await receivedOwner(agentResourcePaths().sharedSkills, name)) continue;
      if (!scopedOnly(db, owner, receiver, name)) continue;
      const built = await buildSkillBundle(path.join(agentResourcePaths().sharedSkills, name), name);
      const grant = scopedOnly(db, owner, receiver, name);
      if (grant) skills.push({ name, digest: built.digest, ...grant });
    }
    requirePeer(db, owner, receiver);
    const result = scopedManifestSchema.parse({ ownerNodeId: owner, skills });
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_MANIFEST_BYTES) throw failure("Skill manifest exceeds limit", 413);
    return result;
  });
}

async function manifestFor(receiver: string) {
  const db = await clusterV2Database(), owner = (await getClusterNode()).id;
  requirePeer(db, owner, receiver);
  await ensureLegacySkillSyncPaused();
  return withSkillMutation(async () => {
    const skills = [];
    for (const name of await managedNames()) {
      if (await receivedOwner(agentResourcePaths().sharedSkills, name)) continue;
      if (!authorizedSkillClusters(db, owner, receiver, name).length) continue;
      const built = await buildSkillBundle(path.join(agentResourcePaths().sharedSkills, name), name);
      if (authorizedSkillClusters(db, owner, receiver, name).length) skills.push({ name, digest: built.digest });
    }
    requirePeer(db, owner, receiver);
    const result = manifestSchema.parse({ ownerNodeId: owner, skills });
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_MANIFEST_BYTES) throw failure("Skill manifest exceeds limit", 413);
    return result;
  });
}
async function bundleFor(receiver: string, name: string) {
  const db = await clusterV2Database(), owner = (await getClusterNode()).id;
  const authorized = async () => {
    if ((!authorizedSkillClusters(db, owner, receiver, name).length && !scopedOnly(db, owner, receiver, name)) || await receivedOwner(agentResourcePaths().sharedSkills, name)
      || await skillSuppressed(agentResourcePaths().sharedSkills, name)) throw failure("Forbidden", 403);
  };
  await authorized();
  await ensureLegacySkillSyncPaused();
  return withSkillMutation(async () => {
    await authorized();
    const result = await buildSkillBundle(path.join(agentResourcePaths().sharedSkills, name), name);
    await authorized();
    return { name, ...result };
  });
}

async function readBounded(response: Response, limit: number): Promise<unknown> {
  if (Number(response.headers.get("Content-Length") ?? "0") > limit) {
    await response.body?.cancel(); throw failure("Cluster peer response exceeds limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw failure("Cluster peer returned an empty response");
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) throw failure("Cluster peer response exceeds limit");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel(); }
}
async function signedSkillPost(db: DatabaseSync, local: string, peer: string, cluster: string, target: string, payload: unknown, limit: number, missingOk = false) {
  requirePeer(db, local, peer, cluster);
  const descriptor = db.prepare("SELECT url FROM cluster_v2_membership_nodes WHERE cluster_id=? AND node_id=?").get(cluster, peer) as { url: string };
  const body = Buffer.from(JSON.stringify(payload));
  const response = await fetch(new URL(target, descriptor.url), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000), body,
    headers: { "Content-Type": "application/json", Authorization: signClusterRequest(db, local, peer, "POST", target, body) },
  });
  // An owner on an older release has no scoped manifest, so it grants nothing scoped.
  if (missingOk && response.status === 404) { await response.body?.cancel(); return null; }
  if (!response.ok) { await response.body?.cancel(); throw failure(`Cluster peer request failed (${response.status})`, 503); }
  const result = await readBounded(response, limit);
  requirePeer(db, local, peer, cluster);
  return result;
}

async function installOffered(db: DatabaseSync, local: string, owner: string, cluster: string, offered: { name: string; digest: string }): Promise<void> {
  const root = agentResourcePaths().sharedSkills, destination = path.join(root, offered.name);
  if (await skillSuppressed(root, offered.name)) return;
  const unchanged = await withSkillMutation(async () => {
    const prior = listReceivedSkills(db).find((item) => item.name === offered.name && item.ownerNodeId === owner);
    if (!prior || !await existing(destination)) return false;
    if ((await buildSkillBundle(destination, offered.name)).digest !== prior.digest) throw failure(`Modified received skill preserved: ${offered.name}`);
    return prior.digest === offered.digest;
  });
  if (unchanged) return;
  const fetched = bundleReplySchema.parse(await signedSkillPost(db, local, owner, cluster, "/api/cluster/v2/skills/bundle", { name: offered.name }, MAX_BUNDLE_RESPONSE_BYTES));
  if (fetched.name !== offered.name || fetched.digest !== offered.digest || skillBundleDigest(fetched.bundle) !== offered.digest) throw failure("Skill digest mismatch");
  await withSkillMutation(async () => {
    requirePeer(db, local, owner, cluster);
    if (await skillSuppressed(root, offered.name)) return;
    const prior = listReceivedSkills(db).find((item) => item.name === offered.name);
    const provenance = await receivedOwner(root, offered.name);
    if ((prior && prior.ownerNodeId !== owner) || (provenance && provenance !== owner)) throw failure(`Skill name conflict: ${offered.name}`);
    if (await existing(destination)) {
      if (!prior) throw failure(`Skill name conflict: ${offered.name}`);
      const actual = (await buildSkillBundle(destination, offered.name)).digest;
      if (actual !== prior.digest) throw failure(`Modified received skill preserved: ${offered.name}`);
      if (actual === offered.digest) return;
    }
    await markReceived(root, offered.name, owner);
    await installSkillBundle(fetched.bundle, offered.name, destination, path.join(resolveDataDirectory(), "skill-staging"));
    db.prepare("INSERT OR REPLACE INTO received_skills VALUES(?,?,?,?)").run(owner, offered.name, offered.digest, new Date().toISOString());
    try { requirePeer(db, local, owner, cluster); }
    catch (error) {
      await removeReceived(db, { ownerNodeId: owner, name: offered.name, digest: offered.digest, updatedAt: new Date().toISOString() });
      throw error;
    }
  });
}
async function removeScoped(db: DatabaseSync, prior: ReceivedScopedSkill): Promise<void> {
  const destination = scopedSkillDirectory(prior.name);
  if (await existing(destination)) {
    if ((await buildSkillBundle(destination, prior.name)).digest !== prior.digest) throw failure(`Modified received skill preserved: ${prior.name}`);
    await backupRemovedSkill(destination);
  }
  await rm(scopedSkillParent(prior.name), { recursive: true, force: true });
  db.prepare("DELETE FROM received_scoped_skills WHERE owner_node_id=? AND name=?").run(prior.ownerNodeId, prior.name);
}

type ScopedOffer = { name: string; digest: string; projectIds: string[]; conversations: SkillConversationGrant[] };
async function installScoped(db: DatabaseSync, local: string, owner: string, cluster: string, offered: ScopedOffer): Promise<void> {
  const destination = scopedSkillDirectory(offered.name);
  const scope = [JSON.stringify(offered.projectIds), JSON.stringify(offered.conversations)];
  // A scoped copy never shadows a skill every conversation here already loads.
  const assertNoConflict = async () => {
    const other = listReceivedScopedSkills(db).find((item) => item.name === offered.name && item.ownerNodeId !== owner);
    if (other || (await managedNames()).includes(offered.name)) throw failure(`Skill name conflict: ${offered.name}`);
  };
  const unchanged = await withSkillMutation(async () => {
    await assertNoConflict();
    const prior = listReceivedScopedSkills(db).find((item) => item.name === offered.name);
    if (!prior || !await existing(destination)) return false;
    if ((await buildSkillBundle(destination, offered.name)).digest !== prior.digest) throw failure(`Modified received skill preserved: ${offered.name}`);
    if (prior.digest !== offered.digest) return false;
    db.prepare("UPDATE received_scoped_skills SET project_ids=?,conversations=? WHERE owner_node_id=? AND name=?").run(...scope, owner, offered.name);
    return true;
  });
  if (unchanged) return;
  const fetched = bundleReplySchema.parse(await signedSkillPost(db, local, owner, cluster, "/api/cluster/v2/skills/bundle", { name: offered.name }, MAX_BUNDLE_RESPONSE_BYTES));
  if (fetched.name !== offered.name || fetched.digest !== offered.digest || skillBundleDigest(fetched.bundle) !== offered.digest) throw failure("Skill digest mismatch");
  await withSkillMutation(async () => {
    requirePeer(db, local, owner, cluster);
    await assertNoConflict();
    const prior = listReceivedScopedSkills(db).find((item) => item.name === offered.name);
    if (await existing(destination)) {
      if (!prior) throw failure(`Skill name conflict: ${offered.name}`);
      if ((await buildSkillBundle(destination, offered.name)).digest !== prior.digest) throw failure(`Modified received skill preserved: ${offered.name}`);
    }
    await installSkillBundle(fetched.bundle, offered.name, destination, path.join(resolveDataDirectory(), "skill-staging"));
    db.prepare("INSERT OR REPLACE INTO received_scoped_skills VALUES(?,?,?,?,?,?)").run(owner, offered.name, offered.digest, new Date().toISOString(), ...scope);
  });
}
async function syncScopedOwner(db: DatabaseSync, local: string, owner: string, cluster: string, errors: Error[]): Promise<void> {
  const reply = await signedSkillPost(db, local, owner, cluster, "/api/cluster/v2/skills/scoped-manifest", {}, MAX_MANIFEST_BYTES, true);
  const manifest = reply === null ? { ownerNodeId: owner, skills: [] } : scopedManifestSchema.parse(reply);
  if (manifest.ownerNodeId !== owner) throw failure("Peer returned the wrong owner");
  for (const offered of manifest.skills) {
    try { await installScoped(db, local, owner, cluster, offered); }
    catch (error) { errors.push(error as Error); }
  }
  await withSkillMutation(async () => {
    requirePeer(db, local, owner, cluster);
    for (const prior of listReceivedScopedSkills(db).filter((item) => item.ownerNodeId === owner && !manifest.skills.some((skill) => skill.name === item.name))) {
      try { await removeScoped(db, prior); } catch (error) { errors.push(error as Error); }
    }
  });
}
function writeScopedIndex(db: DatabaseSync): void {
  writeScopedSkillIndex(listReceivedScopedSkills(db).map(({ name, projectIds, conversations }) => ({ name, projectIds, conversations })));
}

function recordPeerError(db: DatabaseSync, owner: string, error: unknown): void {
  db.prepare("INSERT INTO skill_peer_status(owner_node_id,last_error) VALUES(?,?) ON CONFLICT(owner_node_id) DO UPDATE SET last_error=excluded.last_error")
    .run(owner, (error as Error).message);
}
async function syncOwner(db: DatabaseSync, local: string, owner: string, cluster: string): Promise<void> {
  try {
    const manifest = manifestSchema.parse(await signedSkillPost(db, local, owner, cluster, "/api/cluster/v2/skills/manifest", {}, MAX_MANIFEST_BYTES));
    if (manifest.ownerNodeId !== owner) throw failure("Peer returned the wrong owner");
    const errors: Error[] = [];
    for (const offered of manifest.skills) {
      try { await installOffered(db, local, owner, cluster, offered); }
      catch (error) { errors.push(error as Error); }
    }
    await withSkillMutation(async () => {
      requirePeer(db, local, owner, cluster);
      for (const prior of listReceivedSkills(db).filter((item) => item.ownerNodeId === owner && !manifest.skills.some((skill) => skill.name === item.name))) {
        try { await removeReceived(db, prior); } catch (error) { errors.push(error as Error); }
      }
    });
    await syncScopedOwner(db, local, owner, cluster, errors);
    if (errors.length) throw new Error(errors.map((error) => error.message).join("; "));
    db.prepare("INSERT OR REPLACE INTO skill_peer_status VALUES(?,?,NULL)").run(owner, new Date().toISOString());
  } catch (error) { recordPeerError(db, owner, error); }
}
async function syncSkills(): Promise<void> {
  await ensureLegacySkillSyncPaused();
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  ensureSkillSharingSchema(db);
  const peers = new Map<string, string>();
  for (const membership of listSharingMemberships(db, local)) {
    if (getSharingCluster(db, membership.clusterId).closed) continue;
    for (const member of listSharingClusterMembers(db, membership.clusterId)) if (member.nodeId !== local) peers.set(member.nodeId, membership.clusterId);
  }
  await withSkillMutation(async () => {
    for (const prior of listReceivedSkills(db)) if (!peers.has(prior.ownerNodeId)) {
      try { await removeReceived(db, prior); }
      catch (error) { recordPeerError(db, prior.ownerNodeId, error); }
    }
    for (const prior of listReceivedScopedSkills(db)) if (!peers.has(prior.ownerNodeId)) {
      try { await removeScoped(db, prior); }
      catch (error) { recordPeerError(db, prior.ownerNodeId, error); }
    }
  });
  // No mutation lock spans network I/O: two owners can pull from one another.
  try { await Promise.all([...peers].map(([owner, cluster]) => syncOwner(db, local, owner, cluster))); }
  finally { writeScopedIndex(db); }
}
export async function refreshSharedSkills(): Promise<void> {
  if (!refresh) refresh = syncSkills().finally(() => { refresh = undefined; });
  return refresh;
}

async function shareSkill(name: string, ids: string[], nodeIds: string[], scopes: SkillScopeGrants) {
  await ensureLegacySkillSyncPaused();
  return withSkillMutation(async () => {
    const db = await clusterV2Database(), local = (await getClusterNode()).id;
    const root = agentResourcePaths().sharedSkills;
    if (await receivedOwner(root, name)) throw failure("Received skills cannot be reshared", 403);
    if (!(await managedNames()).includes(name)) throw failure("Managed skill not found", 404);
    if (ids.length || nodeIds.length || scopes.workspaceIds.length || scopes.conversations.length) await buildSkillBundle(path.join(root, name), name);
    try { setSkillShares(db, local, name, ids, nodeIds, scopes); }
    catch (error) { throw failure((error as Error).message, 400); }
    return { name, clusterIds: skillClusterIds(db, local, name), nodeIds: skillNodeIds(db, local, name), ...skillScopeGrants(db, name) };
  });
}
async function removeSkill(name: string) {
  await ensureLegacySkillSyncPaused();
  return withSkillMutation(async () => {
    const db = await clusterV2Database(), local = (await getClusterNode()).id;
    const root = agentResourcePaths().sharedSkills, destination = path.join(root, name);
    if (!(await managedNames()).includes(name)) throw failure("Managed skill not found", 404);
    // A receiver may dismiss its own copy, never revoke the owner's grants.
    await suppressSkill(root, name);
    setSkillShares(db, local, name, []);
    const backup = await backupRemovedSkill(destination);
    await unlinkSkillAliases(destination, aliasRoots());
    await unmarkReceived(root, name);
    db.prepare("DELETE FROM received_skills WHERE name=?").run(name);
    return { removed: name, backup, newConversationRequired: true };
  });
}
function route(action: (request: Request, response: HttpResponse) => Promise<unknown>, machine = false) {
  return (request: Request, response: HttpResponse, next: NextFunction) => {
    void (async () => {
      if (machine ? response.locals.machineProtocol !== 2 : !response.locals.authSession) throw failure("Forbidden", 403);
      response.json(await action(request, response));
    })().catch((error) => {
      if (error instanceof z.ZodError) { sendError(response, 400, "Invalid skill request"); return; }
      if (typeof error.status === "number") { sendError(response, error.status, error.message); return; }
      next(error);
    });
  };
}
export function registerSkillSharingRoutes(): void {
app.get("/api/resources/skills/sharing", route(async () => localView()));
app.put("/api/resources/skills/:name/sharing", route(async (request) => {
  const selection = selectionSchema.parse(request.body);
  return shareSkill(nameSchema.parse(request.params.name), selection.clusterIds, selection.nodeIds, { workspaceIds: selection.workspaceIds, conversations: selection.conversations });
}));
app.delete("/api/resources/skills/:name", route(async (request) => removeSkill(nameSchema.parse(request.params.name))));
app.post("/api/resources/skills/refresh", route(async (request) => { z.object({}).strict().parse(request.body); await refreshSharedSkills(); return localView(); }));
app.post("/api/cluster/v2/skills/manifest", route(async (request, response) => { z.object({}).strict().parse(request.body); return manifestFor(response.locals.machineNodeId); }, true));
app.post("/api/cluster/v2/skills/scoped-manifest", route(async (request, response) => { z.object({}).strict().parse(request.body); return scopedManifestFor(response.locals.machineNodeId); }, true));
app.post("/api/cluster/v2/skills/bundle", route(async (request, response) => bundleFor(response.locals.machineNodeId, z.object({ name: nameSchema }).strict().parse(request.body).name), true));
}
