import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthSession } from "../auth.js";
import { runAsAccount } from "../account-context.js";
import { getClusterNode } from "../cluster.js";
import { accountInCluster } from "../cluster-accounts.js";
import { getSharingCluster, listSharingClusterMembers, listSharingMemberships } from "../cluster-sharing-policy.js";
import { signClusterRequest } from "../cluster-protocol.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { personalSettings, updatePersonalSettings } from "../settings.js";
import { ownerAsActor } from "../ownership.js";
import { listTwinUpdateTargets } from "../twin-updates.js";
import { getProject, listProjects, listWorkspaces } from "../store.js";
import { commandId, commandInScope, commandPeerGrant, commandPolicies, commandPresetSchema, commandSelectionSchema, emptyCommandSelection, recentCommandIds, recordCommandUse, setCommandPolicy, type CommandSelection } from "../saved-commands.js";
import { peerFetch } from "../relay/transport.js";
import { commandManifestSchema, pruneReceivedCommands, readReceivedCommands, replaceReceivedCommands, retainCommandGrants, type CommandOffer } from "../received-commands.js";
import { nodesBlockedBetween } from "../node-blocks.js";
import { whilePeerOptional } from "../peer-presence.js";
import { settled, warnOnChange } from "./quiet-log.js";
import { mayShareProject } from "./sharing-files.js";
import { sendError } from "./http-auth.js";
import { app } from "./state.js";

const contextSchema = z.object({ projectId: z.string().min(1).max(300), conversationId: z.string().min(1).max(300).optional() }).strict();
function failure(message: string, status = 400): Error { return Object.assign(new Error(message), { status }); }

async function peers() {
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  const clusters = listSharingMemberships(db, local).map((m) => getSharingCluster(db, m.clusterId)).filter((c) => !c.closed);
  const nodes = new Map<string, { nodeId: string; name: string; url: string; clusterIds: string[]; incarnations: string[]; twinRelationshipId?: string }>();
  for (const cluster of clusters) for (const member of listSharingClusterMembers(db, cluster.id)) {
    if (member.nodeId === local) continue;
    const descriptor = db.prepare("SELECT name,url FROM cluster_v2_membership_nodes WHERE cluster_id=? AND node_id=?").get(cluster.id, member.nodeId) as { name: string; url: string } | undefined;
    if (!descriptor) continue;
    const node = nodes.get(member.nodeId) ?? { nodeId: member.nodeId, ...descriptor, clusterIds: [], incarnations: [] };
    const owner = listSharingMemberships(db, local).find((m) => m.clusterId === cluster.id)!;
    node.incarnations.push(`${cluster.id}:${owner.joinSequence}:${member.joinSequence}`);
    node.clusterIds.push(cluster.id); nodes.set(member.nodeId, node);
  }
  for (const twin of listTwinUpdateTargets(db, local)) {
    const node = nodes.get(twin.nodeId) ?? { nodeId: twin.nodeId, name: twin.name, url: twin.url, clusterIds: [], incarnations: [] };
    nodes.set(twin.nodeId, { ...node, twinRelationshipId: twin.relationshipId });
  }
  return { db, local, clusters, nodes: [...nodes.values()].filter((node) => !nodesBlockedBetween(db, local, node.nodeId)) };
}
function expandedProjects(db: Awaited<ReturnType<typeof clusterV2Database>>, selection: CommandSelection): string[] {
  const ids = new Set(selection.projectIds);
  for (const workspace of selection.workspaceIds) for (const row of db.prepare("SELECT id FROM projects WHERE workspace_id=?").all(workspace) as Array<{id:string}>) ids.add(row.id);
  return [...ids];
}

/** Read the owning settings row, not a copy of its prompt. Edits and deletions take effect immediately. */
async function manifestFor(receiver: string) {
  const { db, local, nodes } = await peers();
  const peer = nodes.find((n) => n.nodeId === receiver);
  if (!peer) throw failure("Forbidden", 403);
  const commands: CommandOffer[] = [];
  for (const policy of commandPolicies(db)) {
    const grant = commandPeerGrant(db, local, receiver, policy);
    if (!grant.common) continue;
    const account = db.prepare("SELECT username,role FROM users WHERE account_id=? AND disabled=0 AND home_node_id IS NULL").get(policy.accountId) as { username: string; role: "admin" | "member" } | undefined;
    if (!account || policy.nodeSettings !== (account.role === "admin")) continue;
    const grantClusterIds = grant.clusterIds.filter((id) => accountInCluster(db, policy.accountId, id));
    if (!grantClusterIds.length) continue;
    const accessible = new Set((await runAsAccount({ ...account, accountId: policy.accountId, isRemoteLogin: false, homeNodeId: null }, () => listProjects())).map((p) => p.id));
    const row = policy.nodeSettings
      ? db.prepare("SELECT value AS payload FROM node_settings WHERE key='conversationCommands'").get() as {payload:string} | undefined
      : db.prepare("SELECT payload FROM account_settings WHERE account_id=?").get(policy.accountId) as {payload:string} | undefined;
    if (!row) continue;
    const payload = JSON.parse(row.payload);
    const raw = (policy.nodeSettings ? payload : payload.conversationCommands)?.presets?.find((p: {id?:string}) => p.id === policy.presetId);
    const parsed = commandPresetSchema.safeParse(raw);
    if (!parsed.success) continue;
    const projectIds = expandedProjects(db, policy.selection).filter((id) => accessible.has(id) && mayShareProject(db, local, receiver, id));
    const conversations = policy.selection.conversations.filter((c) => accessible.has(c.projectId) && !projectIds.includes(c.projectId) && mayShareProject(db, local, receiver, c.projectId));
    if (!grant.global && !projectIds.length && !conversations.length) continue;
    commands.push({ ...parsed.data, id: commandId(local, policy.accountId, policy.presetId), ownerNodeId: local, global: grant.global, grantClusterIds, projectIds: grant.global ? [] : projectIds, conversations: grant.global ? [] : conversations });
  }
  // Twin trust shares the machine owner's commands, not other local accounts' prompts.
  const owner = ownerAsActor(undefined, db);
  if (peer.twinRelationshipId && owner && db.prepare("SELECT 1 FROM users WHERE role='admin' AND disabled=0 AND home_node_id IS NULL").get()) {
    for (const preset of personalSettings(owner).conversationCommands.presets) {
      const id = commandId(local, owner.accountId, preset.id!);
      const offered = commands.find((command) => command.id === id);
      if (offered) offered.twinRelationshipId = peer.twinRelationshipId;
      else commands.push({ ...preset, id, ownerNodeId: local, global: false, grantClusterIds: [], projectIds: [], conversations: [], twinRelationshipId: peer.twinRelationshipId });
    }
  }
  return { ownerNodeId: local, commands };
}

type Peer = Awaited<ReturnType<typeof peers>>["nodes"][number];
async function commandPost(db: Awaited<ReturnType<typeof clusterV2Database>>, local: string, node: Peer, target: string) {
  const body = Buffer.from("{}");
  return peerFetch(new URL(target, node.url), { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000), body,
    headers: { "Content-Type": "application/json", Authorization: signClusterRequest(db, local, node.nodeId, "POST", target, body) } }, node.nodeId);
}
async function fetchManifest(db: Awaited<ReturnType<typeof clusterV2Database>>, local: string, node: Peer): Promise<CommandOffer[]> {
  const response = await commandPost(db, local, node, "/api/cluster/v2/commands/manifest");
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 403) return []; // The owner explicitly withdrew access.
    throw failure(`Command peer returned ${response.status}`);
  }
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 4 * 1024 * 1024) throw failure("Command manifest exceeds limit"); chunks.push(part.value); } }
  finally { await reader.cancel(); }
  const manifest = commandManifestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (manifest.ownerNodeId !== node.nodeId || manifest.commands.some((c) => c.ownerNodeId !== node.nodeId || !c.id.startsWith(`${node.nodeId}/`))) throw failure("Wrong command owner");
  return manifest.commands;
}
async function syncCommandOwner(owner: string): Promise<void> {
  const { db, local, nodes } = await peers(), node = nodes.find((n) => n.nodeId === owner);
  if (!node) return;
  let commands: CommandOffer[];
  try {
    commands = await fetchManifest(db, local, node);
    settled(`commands:${owner}`);
  } catch (error) {
    warnOnChange(`commands:${owner}`, `Command sync from ${owner} failed; keeping the last synced commands: ${(error as Error).message}`);
    return;
  }
  const current = await peers(), currentNode = current.nodes.find((n) => n.nodeId === owner);
  pruneReceivedCommands(db, current.nodes);
  if (currentNode) replaceReceivedCommands(db, currentNode, retainCommandGrants(commands, node, currentNode));
}
const commandSyncs = new Map<string, Promise<void>>();
function refreshCommandOwner(owner: string, changed = false): Promise<void> {
  const pending = commandSyncs.get(owner);
  if (pending && !changed) return pending;
  // Change notices must fetch after an older in-flight snapshot, not reuse it.
  const work = (async () => { await pending; await syncCommandOwner(owner); })();
  commandSyncs.set(owner, work);
  return work.finally(() => { if (commandSyncs.get(owner) === work) commandSyncs.delete(owner); });
}
export async function refreshSharedCommands(): Promise<void> {
  const { db, nodes } = await peers();
  pruneReceivedCommands(db, nodes);
  await Promise.all(nodes.map((node) => refreshCommandOwner(node.nodeId)));
}
/** Saves never depend on a peer being online. Periodic pulls catch up missed notices. */
export async function announceCommandChanges(): Promise<void> {
  const { db, local, nodes } = await peers();
  await Promise.all(nodes.map(async (node) => {
    try {
      const response = await commandPost(db, local, node, "/api/cluster/v2/commands/changed");
      await response.body?.cancel();
      if (!response.ok) throw failure(`Command peer returned ${response.status}`);
      settled(`command-notice:${node.nodeId}`);
    } catch (error) { warnOnChange(`command-notice:${node.nodeId}`, `Command change notice to ${node.nodeId} failed: ${(error as Error).message}`); }
  }));
}
async function receivedCommands(session: AuthSession) {
  await whilePeerOptional(refreshSharedCommands);
  const { db, nodes } = await peers();
  const ownerSession = session.role === "admin" && !session.isRemoteLogin;
  return nodes.flatMap((node) => readReceivedCommands(db, node).flatMap(({ grantClusterIds, twinRelationshipId, ...command }) => {
    const twinGrant = ownerSession && Boolean(twinRelationshipId);
    const clusterGrant = grantClusterIds.some((id) => accountInCluster(db, session.accountId, id));
    if (!twinGrant && !clusterGrant) return [];
    return [{ ...command, global: command.global || twinGrant, receivedFrom: node.nodeId, receivedFromName: node.name, kind: "received" as const, clusterIds: [], nodeIds: [], workspaceIds: [] }];
  }));
}
async function inventory(session: AuthSession) {
  const { db, local } = await peers();
  const projects = await listProjects(), projectIds = new Set(projects.map((p) => p.id));
  const policies = commandPolicies(db).filter((p) => p.accountId === session.accountId);
  const localCommands = personalSettings().conversationCommands.presets.map((p) => {
    const selection = policies.find((policy) => policy.presetId === p.id)?.selection ?? emptyCommandSelection();
    const scoped = selection.workspaceIds.length + selection.projectIds.length + selection.conversations.length > 0;
    return { ...p, presetId: p.id!, id: commandId(local, session.accountId, p.id!), ownerNodeId: local, kind: "local" as const, ...selection,
      global: !scoped || selection.clusterIds.length > 0 || selection.nodeIds.length > 0,
      expandedProjectIds: expandedProjects(db, selection).filter((id) => projectIds.has(id)) };
  });
  const received = (await receivedCommands(session)).map((c) => ({ ...c, projectIds: c.projectIds.filter((id) => projectIds.has(id)), conversations: c.conversations.filter((item) => projectIds.has(item.projectId)), expandedProjectIds: c.projectIds.filter((id) => projectIds.has(id)) }))
    .filter((c) => c.global || c.projectIds.length || c.conversations.length);
  return [...localCommands, ...received];
}
async function contextCommands(session: AuthSession, input: unknown) {
  const context = contextSchema.parse(input), project = await getProject(context.projectId);
  if (!project) throw failure("Project not found", 404);
  const commands = (await inventory(session)).filter((c) => c.global || commandInScope({ projectIds: c.expandedProjectIds, conversations: c.conversations }, project.id, context.conversationId));
  return { project, commands };
}
function route(action: (request: Request, session: AuthSession, response: Response) => Promise<unknown>, machine = false) {
  return (request: Request, response: Response, next: NextFunction) => {
    void (async () => {
      if (machine ? response.locals.machineProtocol !== 2 : !response.locals.authSession) throw failure("Forbidden", 403);
      response.json(await action(request, response.locals.authSession as AuthSession, response));
    })().catch((error) => {
      if (error instanceof z.ZodError) { sendError(response, 400, "Invalid command request"); return; }
      if (typeof error.status === "number") { sendError(response, error.status, error.message); return; }
      next(error);
    });
  };
}
export function registerSavedCommandRoutes(): void {
  app.get("/api/commands", route(async (request, session) => {
    const { project, commands } = await contextCommands(session, request.query);
    return { commands, recentIds: recentCommandIds(await clusterV2Database(), session.accountId, project.id).filter((id) => commands.some((c) => c.id === id)) };
  }));
  app.post("/api/commands", route(async (request, session) => {
    const preset = commandPresetSchema.omit({ id: true }).parse(request.body);
    const { local } = await peers();
    const settings = personalSettings().conversationCommands;
    if (settings.presets.length >= 50) throw failure("You can save up to 50 commands. Remove one in Settings → Commands first.");
    const saved = updatePersonalSettings({ conversationCommands: { ...settings, presets: [...settings.presets, preset] } }, undefined, session.accountId);
    const command = saved.conversationCommands.presets.at(-1)!;
    await announceCommandChanges();
    return { command: { ...command, id: commandId(local, session.accountId, command.id!) } };
  }));
  app.post("/api/commands/:id/use", route(async (request, session) => {
    const { project, commands } = await contextCommands(session, request.body);
    if (!commands.some((c) => c.id === request.params.id)) throw failure("Command not found", 404);
    recordCommandUse(await clusterV2Database(), session.accountId, project.id, String(request.params.id));
    return { ok: true };
  }));
  app.get("/api/commands/sharing", route(async (_request, session) => {
    const { db, clusters, nodes } = await peers();
    const allowed = clusters.filter((c) => accountInCluster(db, session.accountId, c.id));
    const allowedIds = new Set(allowed.map((c) => c.id));
    return { commands: await inventory(session), clusters: allowed, nodes: nodes.filter((n) => n.clusterIds.some((id) => allowedIds.has(id))).map(({ url: _url, incarnations: _incarnations, ...n }) => ({ ...n, clusterIds: n.clusterIds.filter((id) => allowedIds.has(id)) })), workspaces: await listWorkspaces(), projects: await listProjects() };
  }));
  app.put("/api/commands/:id/sharing", route(async (request, session) => {
    const selection = commandSelectionSchema.parse(request.body), { db, local, nodes } = await peers();
    const preset = personalSettings().conversationCommands.presets.find((p) => commandId(local, session.accountId, p.id!) === request.params.id);
    if (!preset) throw failure("Command not owned by this account; received commands cannot be reshared", 403);
    if (session.isRemoteLogin) throw failure("Change command sharing on the owning node", 403);
    if (selection.clusterIds.some((id) => !accountInCluster(db, session.accountId, id))
      || selection.nodeIds.some((id) => !nodes.some((n) => n.nodeId === id && n.clusterIds.some((cluster) => accountInCluster(db, session.accountId, cluster))))) throw failure("Sharing target is not available to this account", 403);
    const projects = await listProjects(), workspaces = await listWorkspaces();
    if (selection.projectIds.some((id) => !projects.some((p) => p.id === id)) || selection.conversations.some((c) => !projects.some((p) => p.id === c.projectId))) throw failure("Project not found", 404);
    if (selection.workspaceIds.some((id) => !workspaces.some((w) => w.id === id))) throw failure("Workspace not found");
    // A workspace grant must not publish commands through another account's projects.
    for (const id of expandedProjects(db, selection)) if (!projects.some((p) => p.id === id)) throw failure("Workspace contains inaccessible projects", 403);
    try { setCommandPolicy(db, local, session.accountId, preset.id!, session.role === "admin", selection); }
    catch (error) { throw failure((error as Error).message); }
    await announceCommandChanges();
    return { id: request.params.id, ...selection };
  }));
  app.post("/api/commands/refresh", route(async (request, session) => { z.object({}).strict().parse(request.body); return { commands: await inventory(session) }; }));
  app.post("/api/cluster/v2/commands/changed", route(async (request, _session, response) => {
    z.object({}).strict().parse(request.body);
    await refreshCommandOwner(response.locals.machineNodeId, true);
    return { ok: true };
  }, true));
  app.post("/api/cluster/v2/commands/manifest", route(async (request, _session, response) => { z.object({}).strict().parse(request.body); return manifestFor(response.locals.machineNodeId); }, true));
}
