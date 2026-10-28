import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { automationWorkspaceIdentity, ensureAutomationTagSchema, type AutomationTag } from "../automation-tags.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { getSharingCluster, listSharingClusterMembers, listSharingMemberships } from "../cluster-sharing-policy.js";
import { ensureSelectedSharingSchema } from "../selected-sharing.js";
import { postToSharedWorkspacePeer, sharedWorkspacePeerIds } from "./shared-workspaces.js";
import { settled, warnOnChange } from "./quiet-log.js";
import { sendError } from "./http-auth.js";
import { app } from "./state.js";

const tagSchema = z.object({ id: z.string().uuid(), workspaceId: z.string().min(1).max(300), ownerNodeId: z.string().min(1), name: z.string().min(1).max(80), normalizedName: z.string().min(1).max(80), updatedAt: z.string().datetime(), retired: z.boolean() }).strict();
const manifestSchema = z.object({ ownerNodeId: z.string().min(1), tags: z.array(tagSchema).max(100_000) }).strict();
const mutationSchema = z.object({ workspaceId: z.string().min(1).max(300), action: z.enum(["create", "rename", "retire"]), id: z.string().uuid().optional(), name: z.string().trim().min(1).max(80).optional() }).strict();
const failure = (message: string, status = 400) => Object.assign(new Error(message), { status });

async function sharedWorkspacesFor(receiver: string): Promise<string[]> {
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  ensureSelectedSharingSchema(db);
  const query = db.prepare(`SELECT DISTINCT w.id FROM cluster_v2_share_selections s JOIN workspaces w ON w.id=s.resource_id
    WHERE s.kind='workspace' AND s.cluster_id=? AND (s.node_ids IS NULL OR EXISTS(SELECT 1 FROM json_each(s.node_ids) WHERE value=?))
    AND NOT EXISTS (SELECT 1 FROM cluster_v2_shared_workspaces c WHERE c.workspace_id=w.id AND c.workspace_id<>c.source_workspace_id)`);
  const workspaces = new Set<string>();
  for (const membership of listSharingMemberships(db, local, true)) {
    const cluster = getSharingCluster(db, membership.clusterId);
    if (!listSharingClusterMembers(db, cluster.id).some(member => member.nodeId === receiver)) continue;
    for (const row of query.all(cluster.id, receiver) as Array<{ id: string }>) workspaces.add(row.id);
  }
  return [...workspaces];
}

async function manifestFor(receiver: string) {
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  if (!(await sharedWorkspacePeerIds()).includes(receiver)) throw failure("Forbidden", 403);
  const workspaces = await sharedWorkspacesFor(receiver);
  ensureAutomationTagSchema(db);
  const tags = workspaces.length
    ? db.prepare(`SELECT id,workspace_id workspaceId,owner_node_id ownerNodeId,name,normalized_name normalizedName,updated_at updatedAt,retired
      FROM automation_tags WHERE owner_node_id=? AND workspace_id IN (${workspaces.map(() => "?").join(",")}) ORDER BY workspace_id,id`).all(local, ...workspaces) as unknown as AutomationTag[]
    : [];
  return { ownerNodeId: local, tags: tags.map(tag => ({ ...tag, retired: Boolean(tag.retired) })) };
}

async function applyManifest(input: unknown): Promise<void> {
  const manifest = manifestSchema.parse(input), db = await clusterV2Database();
  ensureAutomationTagSchema(db);
  const mapped = db.prepare("SELECT workspace_id workspaceId,source_workspace_id sourceWorkspaceId FROM cluster_v2_shared_workspaces WHERE owner_node_id=? AND workspace_id<>source_workspace_id").all(manifest.ownerNodeId) as Array<{ workspaceId: string; sourceWorkspaceId: string }>;
  const sourceIds = new Set(mapped.map(row => row.sourceWorkspaceId));
  const merge = db.prepare(`INSERT INTO automation_tags(id,owner_node_id,workspace_id,name,normalized_name,updated_at,retired)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,normalized_name=excluded.normalized_name,updated_at=excluded.updated_at,retired=excluded.retired
    WHERE excluded.updated_at>automation_tags.updated_at`);
  db.exec("SAVEPOINT automation_tag_receive");
  try {
    for (const tag of manifest.tags) {
      if (tag.ownerNodeId !== manifest.ownerNodeId) throw failure("Wrong catalog owner", 403);
      if (sourceIds.has(tag.workspaceId)) merge.run(tag.id, tag.ownerNodeId, tag.workspaceId, tag.name, tag.normalizedName, tag.updatedAt, Number(tag.retired));
    }
    db.exec("RELEASE automation_tag_receive");
  } catch (error) {
    db.exec("ROLLBACK TO automation_tag_receive; RELEASE automation_tag_receive");
    throw error;
  }
}

async function refreshOwner(owner: string): Promise<void> {
  try {
    const response = await postToSharedWorkspacePeer(owner, "/api/cluster/v2/automation-tags/manifest");
    if (!response.ok) { await response.body?.cancel(); throw failure(`Workspace peer returned ${response.status}`); }
    const body = await response.json();
    const manifest = manifestSchema.parse(body);
    if (manifest.ownerNodeId !== owner) throw failure("Wrong workspace owner");
    await applyManifest(manifest);
    settled(`automation-tags:${owner}`);
  } catch (error) { warnOnChange(`automation-tags:${owner}`, `Shared automation tag sync from ${owner} failed: ${(error as Error).message}`); }
}

export async function syncSharedAutomationTags(): Promise<void> {
  await Promise.all((await sharedWorkspacePeerIds()).map(refreshOwner));
}

export async function mutateSharedAutomationTag(ownerNodeId: string, input: z.infer<typeof mutationSchema>): Promise<unknown> {
  const response = await postToSharedWorkspacePeer(ownerNodeId, "/api/cluster/v2/automation-tags/mutate", input);
  if (!response.ok) { const detail = await response.text(); throw failure(detail || `Workspace peer returned ${response.status}`, response.status); }
  const result = await response.json();
  await refreshOwner(ownerNodeId);
  return result;
}

export async function announceAutomationTagChanges(): Promise<void> {
  await Promise.all((await sharedWorkspacePeerIds()).map(async nodeId => {
    try {
      const response = await postToSharedWorkspacePeer(nodeId, "/api/cluster/v2/automation-tags/changed");
      await response.body?.cancel();
      if (!response.ok) throw failure(`Workspace peer returned ${response.status}`);
      settled(`automation-tag-notice:${nodeId}`);
    } catch (error) { warnOnChange(`automation-tag-notice:${nodeId}`, `Shared automation tag notice to ${nodeId} failed: ${(error as Error).message}`); }
  }));
}

function machineRoute(action: (request: Request, response: Response, body: unknown) => Promise<unknown>, schema = z.object({}).strict()) {
  return (request: Request, response: Response, next: NextFunction) => {
    void (async () => {
      if (response.locals.machineProtocol !== 2) throw failure("Forbidden", 403);
      const body = schema.parse(request.body);
      response.json(await action(request, response, body));
    })().catch(error => {
      if (error instanceof z.ZodError) { sendError(response, 400, "Invalid automation tag request"); return; }
      if (typeof error.status === "number") { sendError(response, error.status, error.message); return; }
      next(error);
    });
  };
}

export function registerSharedAutomationTagRoutes(): void {
  app.post("/api/cluster/v2/automation-tags/manifest", machineRoute(async (_request, response) => manifestFor(response.locals.machineNodeId)));
  app.post("/api/cluster/v2/automation-tags/changed", machineRoute(async (_request, response) => {
    await refreshOwner(response.locals.machineNodeId);
    return { ok: true };
  }));
  app.post("/api/cluster/v2/automation-tags/mutate", machineRoute(async (_request, response, rawBody) => {
    const actor = response.locals.machineNodeId, input = mutationSchema.parse(rawBody);
    if (!(await sharedWorkspacesFor(actor)).includes(input.workspaceId)) throw failure("Forbidden", 403);
    const db = await clusterV2Database(), local = (await getClusterNode()).id;
    let result: unknown;
    if (input.action === "create") {
      if (!input.name) throw failure("Tag name required");
      result = { tag: (await import("../automation-tags.js")).saveAutomationTag(db, { workspaceId: input.workspaceId, ownerNodeId: local, name: input.name }) };
    } else if (input.action === "rename") {
      if (!input.id || !input.name) throw failure("Tag id and name required");
      result = { tag: (await import("../automation-tags.js")).renameAutomationTag(db, input.workspaceId, input.id, input.name, local) };
    } else {
      if (!input.id) throw failure("Tag id required");
      (await import("../automation-tags.js")).retireAutomationTag(db, input.workspaceId, input.id, local);
      result = { ok: true };
    }
    void announceAutomationTagChanges();
    return result;
  }, mutationSchema));
}
