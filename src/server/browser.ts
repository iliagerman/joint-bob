import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import WebSocket from "ws";
import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { getRuntimePeer, listRuntimePeers, runtimeFetch, runtimeSocketHeaders, trackRuntimeSocket } from "./runtime-peers.js";
import type { DatabaseSync } from "node:sqlite";
import { applyBrowserClusterDefault, applyBrowserConfiguration, browserClusterDefaultSchema, clearBrowserConfiguration, readBrowserClusterDefault, readBrowserClusterDefaults, readBrowserClusterOverrides, readBrowserConfiguration, setBrowserClusterOverride, applyBrowserPreference, readBrowserPreference, browserPreferenceSchema } from "../browser-configuration.js";
import { getSharingCluster, listSharingClusterMembers, listSharingMemberships } from "../cluster-sharing-policy.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { browserCapability, BrowserRuntime } from "../browser-runtime.js";
import { browserCommandSchema, browserStartSchema, browserIdentitySchema, browserProfileGrantInputSchema, type BrowserActor, type BrowserProfile, type BrowserSessionView } from "../browser-types.js";
import { enqueueSystemPrompt } from "../prompt-queue.js";
import { getProject } from "../store.js";
import { clusterPeerMayAccessProject } from "./cluster-helpers.js";
import { broadcastToProject, wakeQueuedConversations } from "./realtime.js";
import { isPeerUnreachable } from "./peer-availability.js";
import { peerSnapshot, staleSnapshotReason } from "./peer-snapshots.js";

export class BrowserRequestError extends Error { constructor(public status: number, message: string) { super(message); } }
let runtime: BrowserRuntime | undefined;
export function browserRuntime(): BrowserRuntime { return runtime ??= new BrowserRuntime(); }
export async function closeBrowserRuntime(): Promise<void> { await runtime?.close(); runtime = undefined; }
// Old releases adopt the config in any peer's status reply; peers get one too old to win.
const unsetBrowserConfiguration = { executorNodeId: null, updatedAt: "1970-01-01T00:00:00.000Z", originNodeId: "00000000-0000-0000-0000-000000000000" };
function clusterMemberIds(db: DatabaseSync, clusterId: string): string[] {
  try { return listSharingClusterMembers(db, clusterId).map(member => member.nodeId); } catch { return []; }
}
let browserDefaultVetted = false;
/** Earlier releases copied peers' defaults, so a choice made on another machine may be stored here. */
async function vetBrowserDefault(): Promise<void> {
  if (browserDefaultVetted) return;
  browserDefaultVetted = true;
  const config = readBrowserConfiguration();
  if (config.executorNodeId !== null && config.originNodeId !== (await getClusterNode()).id) clearBrowserConfiguration();
}
/** A cluster's suggestion comes only from its members and names one of its members. */
export async function acceptBrowserClusterDefault(senderNodeId: string, input: unknown): Promise<boolean> {
  const value = browserClusterDefaultSchema.parse(input), db = await clusterV2Database(), local = (await getClusterNode()).id;
  const members = clusterMemberIds(db, value.clusterId);
  if (![local, senderNodeId, value.originNodeId].every(node => members.includes(node))) return false;
  if (value.executorNodeId && !members.includes(value.executorNodeId)) return false;
  applyBrowserClusterDefault(value);
  return true;
}
export async function localBrowserStatus(callerNodeId?: string) {
  await vetBrowserDefault();
  const node = await getClusterNode(), db = await clusterV2Database();
  const shared = (clusterId: string) => !callerNodeId || clusterMemberIds(db, clusterId).includes(callerNodeId);
  return {
    node: { id: node.id, name: node.name },
    config: callerNodeId ? unsetBrowserConfiguration : readBrowserConfiguration(),
    clusterDefaults: readBrowserClusterDefaults().filter(entry => shared(entry.clusterId) && clusterMemberIds(db, entry.clusterId).includes(node.id)),
    capability: await browserCapability(),
    runningCount: (await browserRuntime().list()).filter(row => row.state === "running").length,
  };
}
async function memberClusterIds(): Promise<string[]> {
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  try { return listSharingMemberships(db, local).map(({ clusterId }) => clusterId); } catch { return []; }
}
async function browserClusters() {
  const db = await clusterV2Database(), overrides = readBrowserClusterOverrides();
  return (await memberClusterIds()).flatMap(clusterId => {
    try {
      return [{
        id: clusterId, name: getSharingCluster(db, clusterId).name, memberNodeIds: clusterMemberIds(db, clusterId),
        executorNodeId: readBrowserClusterDefault(clusterId)?.executorNodeId ?? null,
        overrideNodeId: overrides.find(entry => entry.clusterId === clusterId)?.executorNodeId ?? null,
      }];
    } catch { return []; }
  });
}
export type BrowserDefaultSource = "override" | "cluster" | "machine";
/**
 * The machine a new browser opens on when its conversation chose none. For a project shared in a
 * cluster: this machine's override for that cluster, else the cluster's suggestion. Otherwise, or
 * when its clusters suggest nothing, this machine's own default.
 */
export async function browserDefault(projectId?: string): Promise<{ nodeId: string | null; source: BrowserDefaultSource | null; clusterId?: string }> {
  await vetBrowserDefault();
  const members = new Set(await memberClusterIds());
  const clusters = new Set(((projectId ? (await getProject(projectId))?.clusterIds : undefined) ?? []).filter(clusterId => members.has(clusterId)));
  const latest = <T extends { clusterId: string; updatedAt: string; executorNodeId: string | null }>(entries: T[]) =>
    entries.filter(entry => entry.executorNodeId && clusters.has(entry.clusterId)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  const override = latest(readBrowserClusterOverrides());
  if (override) return { nodeId: override.executorNodeId, source: "override", clusterId: override.clusterId };
  const suggestion = latest(readBrowserClusterDefaults());
  if (suggestion) return { nodeId: suggestion.executorNodeId, source: "cluster", clusterId: suggestion.clusterId };
  const own = readBrowserConfiguration().executorNodeId;
  return own ? { nodeId: own, source: "machine" } : { nodeId: null, source: null };
}
/** With a project, lists only the machines that project is shared with, so a conversation never offers another cluster's machines. */
export async function browserStatus(nodeId?: string, projectId?: string) {
  if (nodeId && idSchema.parse(nodeId) !== (await getClusterNode()).id) return (await peerRequest(nodeId, "status", {}, 5000)).json();
  const project = projectId ? await getProject(projectId) : undefined;
  if (projectId && !project) throw new BrowserRequestError(404, "Project not found");
  const own = await localBrowserStatus();
  const nodes = [{ ...own.node, ...own.capability, reachable: true, runningCount: own.runningCount }];
  nodes.push(...await Promise.all((await listRuntimePeers(project?.id)).map(async peer => {
    let status: Awaited<ReturnType<typeof localBrowserStatus>>;
    try {
      status = await (await peerRequest(peer.id, "status", {}, 5000)).json() as Awaited<ReturnType<typeof localBrowserStatus>>;
    } catch (error) {
      return { id: peer.id, name: peer.name, supported: false, available: false, executable: null, reachable: false, runningCount: 0, reason: error instanceof Error ? error.message : "Browser node unavailable" };
    }
    // Pull-on-use convergence also covers a node that was offline when a default changed.
    for (const entry of status.clusterDefaults ?? []) await acceptBrowserClusterDefault(peer.id, entry).catch(() => false);
    return { id: peer.id, name: peer.name, ...status.capability, reachable: true, runningCount: status.runningCount };
  })));
  return { ...own, config: readBrowserConfiguration(), clusterDefaults: readBrowserClusterDefaults(), clusters: await browserClusters(), default: await browserDefault(project?.id), nodes };
}
async function knownNode(nodeId: string): Promise<void> {
  idSchema.parse(nodeId);
  if (nodeId !== (await getClusterNode()).id && !(await getRuntimePeer(nodeId))) throw new BrowserRequestError(503, "Browser node is no longer paired");
}
/** Sets this machine's fallback for projects whose clusters suggest no machine. Stays on this machine. */
export async function configureBrowserExecutor(executorNodeId: string | null) {
  if (executorNodeId) await knownNode(executorNodeId);
  await vetBrowserDefault();
  applyBrowserConfiguration({ executorNodeId, originNodeId: (await getClusterNode()).id, updatedAt: nextVersion(readBrowserConfiguration().updatedAt) });
  return browserStatus();
}
/** Replaces a cluster's suggestion on this machine only; null follows the cluster again. */
export async function configureClusterBrowserOverride(clusterId: string, executorNodeId: string | null) {
  idSchema.parse(clusterId);
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  const members = clusterMemberIds(db, clusterId);
  if (!members.includes(local)) throw new BrowserRequestError(404, "This machine is not a member of that cluster");
  if (executorNodeId && !members.includes(executorNodeId)) throw new BrowserRequestError(400, "That machine is not a member of this cluster");
  setBrowserClusterOverride(clusterId, executorNodeId);
  return browserStatus();
}
/** Sets the browser machine a cluster suggests to its members; null clears the suggestion. */
export async function configureClusterBrowserDefault(clusterId: string, executorNodeId: string | null) {
  idSchema.parse(clusterId);
  await browserStatus();
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  const members = clusterMemberIds(db, clusterId);
  if (!members.includes(local)) throw new BrowserRequestError(404, "This machine is not a member of that cluster");
  if (executorNodeId && !members.includes(executorNodeId)) throw new BrowserRequestError(400, "That machine is not a member of this cluster");
  applyBrowserClusterDefault({ clusterId, executorNodeId, originNodeId: local, updatedAt: nextVersion(readBrowserClusterDefault(clusterId)?.updatedAt) });
  const value = readBrowserClusterDefault(clusterId);
  await Promise.all((await listRuntimePeers()).filter(peer => members.includes(peer.id)).map(async peer => {
    try { await peerRequest(peer.id, "cluster-default", value, 5000); }
    catch (error) { console.warn(`Browser cluster default sync to ${peer.id} failed`, error); }
  }));
  return browserStatus();
}
function nextVersion(previous?: string) { return new Date(Math.max(Date.now(), previous ? Date.parse(previous) + 1 : 0)).toISOString(); }
export async function canonicalBrowserIdentity(input: z.infer<typeof browserIdentitySchema>) {
  const identity = browserIdentitySchema.parse(input);
  const project = await getProject(identity.projectId);
  if (!project) throw new BrowserRequestError(404, "Project not found");
  return { ...identity, projectId: project.id };
}
export async function browserPreferences(input: z.infer<typeof browserIdentitySchema>, update?: { nodeId: string | null }) {
  const identity = await canonicalBrowserIdentity(input);
  await browserStatus();
  const peers = await sharedBrowserPeers(identity.projectId);
  await Promise.all(peers.map(async peer => {
    try {
      const result = await (await peerRequest(peer.id, "preferences", { identity, preference: readBrowserPreference(identity) }, 5000)).json();
      if (result.preference) applyBrowserPreference({ ...browserPreferenceSchema.parse(result.preference), ...identity });
    } catch (error) { console.warn(`Browser preference sync to ${peer.id} failed`, error); }
  }));
  if (update) {
    if (update.nodeId) {
      await knownNode(update.nodeId);
      if (update.nodeId !== (await getClusterNode()).id && !await clusterPeerMayAccessProject(update.nodeId, identity.projectId)) throw new BrowserRequestError(403, "This project is not shared with that machine");
    }
    applyBrowserPreference({ ...identity, nodeId: update.nodeId, originNodeId: (await getClusterNode()).id, updatedAt: nextVersion(readBrowserPreference(identity)?.updatedAt) });
    await Promise.all(peers.map(async peer => {
      try { await peerRequest(peer.id, "preferences", { identity, preference: readBrowserPreference(identity) }, 5000); }
      catch (error) { console.warn(`Browser preference sync to ${peer.id} failed`, error); }
    }));
  }
  const preference = readBrowserPreference(identity);
  const fallback = await browserDefault(identity.projectId);
  return { nodeId: preference?.nodeId ?? null, effectiveNodeId: preference?.nodeId ?? fallback.nodeId, defaultNodeId: fallback.nodeId, defaultSource: fallback.source };
}
async function sharedBrowserPeers(projectId?: string) {
  const peers = await listRuntimePeers();
  if (!projectId) return peers;
  return (await Promise.all(peers.map(async peer => await clusterPeerMayAccessProject(peer.id, projectId) ? peer : null))).filter(peer => peer !== null);
}

/** peerRequest reports any failure to reach the peer as 503. */
function browserPeerUnreachable(error: unknown): boolean {
  return error instanceof BrowserRequestError ? error.status === 503 : isPeerUnreachable(error);
}

// Relay browser control only. Website network traffic remains executor-local.
async function peerRequest(peerId: string, route: string, body: unknown, timeout = 60000): Promise<Response> {
  const peer = await getRuntimePeer(peerId);
  if (!peer) throw new BrowserRequestError(503, "Browser node is no longer paired");
  let response: Response;
  try {
    response = await runtimeFetch(`${peer.url}/api/cluster/browser/${route}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
    });
  } catch { throw new BrowserRequestError(503, "Browser node is unreachable. Its browser is not moved to another node."); }
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { error?: string };
    throw new BrowserRequestError(response.status, error.error || `Browser node returned ${response.status}`);
  }
  return response;
}
const idSchema = z.string().uuid();
const profileAccessContextSchema = z.object({ id: idSchema, projectId: z.string().min(1).max(200), conversationId: z.string().min(1).max(200).optional() });
export const profileAccessUpdateSchema = z.object({
  crossNodeAccess: z.boolean().optional(),
  grant: browserProfileGrantInputSchema.optional(),
  revoke: browserProfileGrantInputSchema.optional(),
}).strict().refine(update => [update.crossNodeAccess, update.grant, update.revoke].filter(value => value !== undefined).length <= 1,
  "Send one profile access change per request; an empty body reads the current access");
export const browserOperationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("start"), args: browserStartSchema }),
  z.object({ operation: z.literal("list"), args: browserIdentitySchema.partial() }),
  z.object({ operation: z.literal("get"), args: z.object({ id: idSchema }) }),
  z.object({ operation: z.literal("forget"), args: z.object({ id: idSchema }) }),
  z.object({ operation: z.literal("command"), args: z.object({ id: idSchema, command: browserCommandSchema }) }),
  z.object({ operation: z.literal("profiles"), args: z.object({ projectId: z.string().min(1).max(200), conversationId: z.string().min(1).max(200).optional() }) }),
  z.object({ operation: z.literal("deleteProfile"), args: profileAccessContextSchema }),
  z.object({ operation: z.literal("profileAccess"), args: profileAccessContextSchema.extend({ update: profileAccessUpdateSchema }) }),
]);
export type BrowserOperation = z.infer<typeof browserOperationSchema>;
export async function localBrowserOperation(input: BrowserOperation, actor: BrowserActor, machineNodeId?: string, agentIdentity?: z.infer<typeof browserIdentitySchema>): Promise<unknown> {
  const operation = browserOperationSchema.parse(input);
  const local = await getClusterNode();
  const service = browserRuntime();
  // Legacy central-runner records name another app node, but their browser
  // history, downloads and profiles still belong to this physical node.
  const view = (session: BrowserSessionView) => ({ ...session, nodeId: local.id });
  // Cross-node access is an independent per-profile toggle. When it is off, the
  // owning node serves the profile and its sessions; relayed requests stop here,
  // before grant checks or any native launch.
  const assertNodeAccess = (profile: { crossNodeAccess?: boolean } | null): void => {
    if (!machineNodeId || !profile || profile.crossNodeAccess !== false) return;
    throw new BrowserRequestError(403, "Browser profile is restricted to this node");
  };
  // A relayed caller sees grant metadata only for projects its invitation
  // shares. An agent — local or relayed — sees only the grants its own project
  // and conversation make usable; assignments naming other conversations or
  // projects are not its metadata to read.
  const visibleGrants = async (grants: BrowserProfile["grants"]): Promise<BrowserProfile["grants"]> => {
    if (!grants) return grants;
    const agentScope = agentIdentity ?? (actor.kind === "agent" && operation.operation === "profiles" ? { projectId: operation.args.projectId, conversationId: operation.args.conversationId } : undefined);
    if (agentScope) return grants.filter(grant => grant.scope === "global"
      || (grant.projectId === agentScope.projectId && (grant.scope !== "conversation" || grant.conversationId === agentScope.conversationId)));
    if (!machineNodeId) return grants;
    const allowed = await Promise.all(grants.map(async grant => grant.projectId === undefined || await clusterPeerMayAccessProject(machineNodeId, grant.projectId) ? grant : null));
    return allowed.filter(grant => grant !== null);
  };
  const projectId = "projectId" in operation.args ? operation.args.projectId : "id" in operation.args ? (await service.get(operation.args.id)).projectId : undefined;
  if (projectId) {
    const project = await getProject(projectId);
    if (!project) throw new BrowserRequestError(404, "Project not found on browser node");
    if (machineNodeId && !(await clusterPeerMayAccessProject(machineNodeId, projectId))) throw new BrowserRequestError(403, "Project is not shared with this node");
    if ("projectId" in operation.args) operation.args.projectId = project.id;
  }
  // Grants reference canonical project ids; a grant naming another project must
  // resolve on this, the profile-owning node.
  const canonicalGrantProject = async (projectId: string | undefined): Promise<string | undefined> => {
    if (projectId === undefined) return undefined;
    const project = await getProject(projectId);
    if (!project) throw new BrowserRequestError(404, "Grant project not found on browser node");
    if (machineNodeId && !(await clusterPeerMayAccessProject(machineNodeId, project.id))) throw new BrowserRequestError(403, "Project is not shared with this node");
    return project.id;
  };
  // The agent identity is enforced for local operations too, not only on the
  // relay: a conversation's agent may touch only its own sessions and profiles.
  // A revoked grant hides the session and its metadata — except closing, which
  // stays available through the same shared permission check as every path.
  const assertAgentSession = async (id: string, exemptClose = false): Promise<BrowserSessionView> => {
    const session = await service.get(id);
    if (agentIdentity) {
      if (session.projectId !== agentIdentity.projectId || session.conversationId !== agentIdentity.conversationId)
        throw new BrowserRequestError(403, "Browser is not attached to this conversation");
      if (session.profileId && !exemptClose && !service.profileUsable(session.profileId, session.projectId, session.conversationId))
        throw new BrowserRequestError(403, "Browser profile grant was revoked for this conversation");
    }
    return session;
  };
  // Management is bound to the actual profile, not the project id in the URL: the
  // caller must reach the profile through its home project, one of its grants, or
  // the conversation the viewer is attached to.
  const assertManageable = (profile: { id: string; projectId: string }, projectId: string, conversationId?: string): void => {
    if (profile.projectId === projectId || service.profileUsable(profile.id, projectId) || (conversationId && service.profileUsable(profile.id, projectId, conversationId))) return;
    throw new BrowserRequestError(403, "Browser profile cannot be managed from this project");
  };
  switch (operation.operation) {
    case "start": {
      await knownNode(operation.args.appNodeId);
      if (operation.args.profileId) {
        const profile = service.profile(operation.args.profileId); // 404 when this node does not own it
        assertNodeAccess(profile);
        if (!service.profileUsable(operation.args.profileId, operation.args.projectId, operation.args.conversationId))
          throw new BrowserRequestError(403, "Browser profile is not granted to this conversation");
      }
      return { session: view(await service.create(operation.args, actor.kind === "agent" ? actor.credentialOrigins ?? [] : [], { remote: Boolean(machineNodeId) })) };
    }
    case "list": {
      const sessions = (await service.list(operation.args)).map(view);
      // An agent's listing redacts live page and account metadata for sessions
      // whose profile grant is gone; identity fields stay so it can close them.
      // Humans — local or relayed — keep the full view.
      const redacted = sessions.map(session => actor.kind === "agent" && session.profileId && !service.profileUsable(session.profileId, session.projectId, session.conversationId)
        ? { ...session, tabs: [], activePageId: null, loginRequest: null, downloads: [], fileChooser: false, fileChooserRequest: null, dialog: null, accessRevoked: true }
        : session);
      const allowed = machineNodeId ? await Promise.all(redacted.map(async session => (await clusterPeerMayAccessProject(machineNodeId, session.projectId)) && service.profileOrNull(session.profileId)?.crossNodeAccess !== false ? session : null)) : redacted;
      return { sessions: allowed.filter(Boolean) };
    }
    case "get": { const session = await assertAgentSession(operation.args.id); await assertNodeAccess(service.profileOrNull(session.profileId)); return { session: view(session) }; }
    case "forget": { const session = await assertAgentSession(operation.args.id); await assertNodeAccess(service.profileOrNull(session.profileId)); await service.forget(operation.args.id); return { forgotten: true, projectId: session.projectId }; }
    case "command": {
      const session = await assertAgentSession(operation.args.id, operation.args.command.action === "close");
      await assertNodeAccess(service.profileOrNull(session.profileId));
      const result = await service.execute(operation.args.id, operation.args.command, actor, Boolean(machineNodeId));
      const updated = view(await service.get(operation.args.id));
      if (operation.args.command.action === "completeLogin") announceBrowserLoginCompleted(updated, operation.args.command.requestId);
      return { result, session: updated };
    }
    case "profiles": {
      // Grant-based listing: what this conversation may open. Agents and relayed
      // callers see strictly granted, cross-node-allowed profiles. The owner
      // node's human also sees its project's other entities — profiles granted
      // only elsewhere stay manageable and grantable — with their real grants,
      // without granting any conversation implicit access.
      const profiles = await service.usableProfiles(operation.args.projectId, operation.args.conversationId);
      const localHuman = !machineNodeId && actor.kind === "human";
      const dormant = localHuman
        ? (await service.profiles(operation.args.projectId)).filter(profile => !profiles.some(visible => visible.id === profile.id)).map(profile => ({ ...profile, grants: service.profileGrants(profile.id) }))
        : [];
      return { profiles: await Promise.all([...profiles, ...dormant].filter(profile => profile.crossNodeAccess !== false || !machineNodeId).map(async profile => ({ ...profile, grants: await visibleGrants(profile.grants), nodeId: local.id }))) };
    }
    case "deleteProfile": {
      const profile = service.profile(operation.args.id);
      assertNodeAccess(profile);
      assertManageable(profile, operation.args.projectId);
      await service.deleteProfile(operation.args.id, operation.args.projectId);
      return { deleted: true };
    }
    case "profileAccess": {
      const profile = service.profile(operation.args.id);
      assertNodeAccess(profile);
      // Management is bound to the actual profile: the caller must reach it through
      // its home project or a grant, not through an arbitrary shared project id.
      assertManageable(profile, operation.args.projectId, operation.args.conversationId);
      const update = operation.args.update;
      if (machineNodeId && update.grant?.scope === "global") throw new BrowserRequestError(403, "Global profile access can only be granted on the profile's owning node");
      if (machineNodeId && update.crossNodeAccess === true) throw new BrowserRequestError(403, "Cross-node profile access can only be enabled on the profile's owning node");
      let next = profile;
      if (update.crossNodeAccess !== undefined) next = await service.setProfileCrossNode(operation.args.id, update.crossNodeAccess);
      for (const [kind, grant] of [["grant", update.grant], ["revoke", update.revoke]] as const) {
        if (!grant) continue;
        const projectId = await canonicalGrantProject(grant.projectId);
        const grants = kind === "grant"
          ? service.grantProfileAccess(operation.args.id, { scope: grant.scope, ...(projectId ? { projectId } : {}), ...(grant.conversationId ? { conversationId: grant.conversationId } : {}) })
          : service.revokeProfileAccess(operation.args.id, { scope: grant.scope, ...(projectId ? { projectId } : {}), ...(grant.conversationId ? { conversationId: grant.conversationId } : {}) });
        next = { ...next, grants };
      }
      return { profile: { ...next, grants: await visibleGrants(service.profileGrants(operation.args.id)), nodeId: local.id } };
    }
  }
}
/** A verified Done resumes the conversation without a manual "continue" message.
 * The queued prompt replicates to the conversation's node; the local wake covers
 * the common case where the harness runs on this node. */
function announceBrowserLoginCompleted(session: BrowserSessionView, requestId: string): void {
  try {
    enqueueSystemPrompt(`${session.projectId}:${session.conversationId}`, requestId,
      `Browser sign-in completed: the human finished signing in on "${session.profileLabel || "the browser"}" and chose Done, returning control to the agent. Re-inspect the signed-in page state, then continue the paused browser task.`);
    wakeQueuedConversations();
  } catch (error) { console.warn("Browser login continuation prompt failed", error); }
}

export interface BrowserDiscovery { sessions: BrowserSessionView[]; unavailableNodes: Array<{ nodeId: string; reason: string }>; }
export function requireCompleteDiscovery(discovery: BrowserDiscovery) {
  if (discovery.unavailableNodes.length) throw new BrowserRequestError(503, `Browser attachment discovery incomplete: ${discovery.unavailableNodes.map(node => `${node.nodeId}: ${node.reason}`).join("; ")}. No account was selected or created.`);
}
export async function browserOperation(input: BrowserOperation, actor: BrowserActor, nodeId?: string, identity?: z.infer<typeof browserIdentitySchema>): Promise<unknown> {
  const operation = browserOperationSchema.parse(input);
  if (operation.operation === "list" && !nodeId) return discoverBrowsers(operation, actor, identity);
  if (operation.operation === "start") {
    const result = await startBrowser(operation, actor, nodeId, identity);
    broadcastToProject(operation.args.projectId, { type: "browserSessionsChanged" });
    return result;
  }
  if (!nodeId && (operation.operation === "get" || operation.operation === "command" || operation.operation === "forget")) nodeId = await browserSessionOwner(operation.args.id, actor, identity);
  if (!nodeId || idSchema.parse(nodeId) === (await getClusterNode()).id) {
    const result = await localBrowserOperation(operation, actor, undefined, actor.kind === "agent" ? identity : undefined);
    if (operation.operation === "forget") broadcastToProject((result as { projectId: string }).projectId, { type: "browserSessionsChanged" });
    return result;
  }
  const result = await (await peerRequest(nodeId, "operation", { ...operation, actor, identity })).json();
  if (operation.operation === "forget") broadcastToProject((result as { projectId: string }).projectId, { type: "browserSessionsChanged" });
  return result;
}
async function discoverBrowsers(operation: Extract<BrowserOperation, { operation: "list" }>, actor: BrowserActor, identity?: z.infer<typeof browserIdentitySchema>): Promise<BrowserDiscovery> {
  const local = await localBrowserOperation(operation, actor) as { sessions: BrowserSessionView[] };
  const result: BrowserDiscovery = { sessions: local.sessions, unavailableNodes: [] };
  await Promise.all((await sharedBrowserPeers(operation.args.projectId)).map(async peer => {
    try {
      const remote = await peerSnapshot(`browser:${JSON.stringify([operation, actor, identity ?? null])}`, peer.id,
        async () => await (await peerRequest(peer.id, "operation", { ...operation, actor, identity }, 5000)).json() as { sessions: BrowserSessionView[] },
        { unreachable: browserPeerUnreachable });
      result.sessions.push(...remote.value.sessions.map(session => ({ ...session, nodeId: peer.id })));
      if (!remote.fresh) result.unavailableNodes.push({ nodeId: peer.id, reason: staleSnapshotReason(remote.fetchedAt) });
    } catch (error) {
      if (error instanceof BrowserRequestError && ((error.status === 403 && /Project is not shared/.test(error.message)) || (error.status === 404 && /Project not found/.test(error.message)))) return;
      result.unavailableNodes.push({ nodeId: peer.id, reason: error instanceof Error ? error.message : "Browser node unavailable" });
    }
  }));
  return result;
}

/** Every usable profile across this node and shared peers, for one conversation. */
export async function discoverBrowserProfiles(identity: z.infer<typeof browserIdentitySchema>, actor: BrowserActor, options: { conversationScoped?: boolean } = {}): Promise<BrowserDiscovery & { profiles: Array<BrowserProfile & { nodeId: string }> }> {
  const args = { projectId: identity.projectId, ...(options.conversationScoped === false ? {} : { conversationId: identity.conversationId }) };
  const localNode = await getClusterNode();
  const local = await localBrowserOperation({ operation: "profiles", args }, actor) as { profiles: BrowserProfile[] };
  const result: BrowserDiscovery & { profiles: Array<BrowserProfile & { nodeId: string }> } = { sessions: [], unavailableNodes: [], profiles: local.profiles.map(profile => ({ ...profile, nodeId: localNode.id })) };
  await Promise.all((await sharedBrowserPeers(identity.projectId)).map(async peer => {
    try {
      const remote = await peerSnapshot(`browser-profiles:${JSON.stringify([args, actor, identity])}`, peer.id,
        async () => await (await peerRequest(peer.id, "operation", { operation: "profiles", args, actor, identity }, 5000)).json() as { profiles: BrowserProfile[] },
        // Attaching refuses to pick an account while any node is unaccounted for, so a slow
        // peer keeps its full answer time here; a peer known to be down still fails at once.
        { unreachable: browserPeerUnreachable, waitMs: 5_000 });
      result.profiles.push(...remote.value.profiles.map(profile => ({ ...profile, nodeId: peer.id })));
      if (!remote.fresh) result.unavailableNodes.push({ nodeId: peer.id, reason: staleSnapshotReason(remote.fetchedAt) });
    } catch (error) {
      if (error instanceof BrowserRequestError && ((error.status === 403 && /Project is not shared/.test(error.message)) || (error.status === 404 && /Project not found/.test(error.message)))) return;
      result.unavailableNodes.push({ nodeId: peer.id, reason: error instanceof Error ? error.message : "Browser node unavailable" });
    }
  }));
  return result;
}
async function startBrowser(operation: Extract<BrowserOperation, { operation: "start" }>, actor: BrowserActor, nodeId?: string, identity?: z.infer<typeof browserIdentitySchema>) {
  const scope = browserIdentitySchema.parse(operation.args);
  if (operation.args.profileId) {
    const listed = await discoverBrowsers({ operation: "list", args: scope }, actor, identity);
    const attached = listed.sessions.filter(session => session.profileId === operation.args.profileId);
    const owners = new Set(attached.map(session => session.nodeId));
    if (owners.size > 1) throw new BrowserRequestError(409, "Browser profile has multiple physical owners");
    const owner = attached[0]?.nodeId;
    if (owner && nodeId && owner !== nodeId) {
      if (listed.unavailableNodes.some((node) => node.nodeId === owner)) throw new BrowserRequestError(503, `Browser machine ${owner} is unavailable; no fallback was attempted`);
      throw new BrowserRequestError(409, `Browser profile belongs to machine ${owner}, not ${nodeId}`);
    }
    if (owner) nodeId = owner;
    else {
      // Cold start: no session pins the profile yet. An explicit machine is trusted
      // as given — its own checks answer precisely and nothing falls back. Otherwise
      // route by the profile's discovered owner: this node first, then every shared
      // peer, scoped to this conversation and then unscoped.
      if (nodeId === (await getClusterNode()).id && !browserRuntime().profileOrNull(operation.args.profileId)) requireCompleteDiscovery(listed);
      if (!nodeId) {
        requireCompleteDiscovery(listed);
        if (browserRuntime().profileOrNull(operation.args.profileId)) nodeId = (await getClusterNode()).id;
        else {
          const scoped = await discoverBrowserProfiles(scope, actor);
          requireCompleteDiscovery(scoped);
          let holder = scoped.profiles.find(profile => profile.id === operation.args.profileId);
          if (!holder) {
            const unscoped = await discoverBrowserProfiles(scope, actor, { conversationScoped: false });
            requireCompleteDiscovery(unscoped);
            holder = unscoped.profiles.find(profile => profile.id === operation.args.profileId);
          }
          if (!holder) throw new BrowserRequestError(404, "Browser profile not found on any paired browser machine");
          nodeId = holder.nodeId;
        }
      }
    }
  } else if (!nodeId) nodeId = (await browserPreferences(scope)).effectiveNodeId ?? undefined;
  if (!nodeId) throw new BrowserRequestError(409, "Choose a browser machine in Settings first");
  await knownNode(nodeId);
  if (nodeId === (await getClusterNode()).id) return localBrowserOperation(operation, actor);
  return (await peerRequest(nodeId, "operation", { ...operation, actor, identity })).json();
}
export async function authorizeBrowserAgent(operation: BrowserOperation, input: z.infer<typeof browserIdentitySchema>) {
  const identity = await canonicalBrowserIdentity(input);
  if ("projectId" in operation.args) {
    const project = await getProject(operation.args.projectId!);
    if (project?.id !== identity.projectId) throw new BrowserRequestError(403, "Browser project does not match agent identity");
  }
  if (operation.operation === "deleteProfile" || operation.operation === "profileAccess") throw new BrowserRequestError(403, "Agents cannot manage browser profiles");
  if (operation.operation === "list" || operation.operation === "start") {
    if (operation.args.engine !== identity.engine || operation.args.conversationId !== identity.conversationId) throw new BrowserRequestError(403, "Browser conversation does not match agent identity");
  }
  if (operation.operation === "get" || operation.operation === "command") {
    const session = await browserRuntime().get(operation.args.id);
    if (session.projectId !== identity.projectId || session.conversationId !== identity.conversationId) throw new BrowserRequestError(403, "Browser is not attached to this conversation");
    // A revoked grant pauses the conversation's automation at once; closing stays
    // available so the agent can end the session it can no longer drive.
    if (session.profileId && !(operation.operation === "command" && operation.args.command.action === "close")
      && !browserRuntime().profileUsable(session.profileId, identity.projectId, identity.conversationId))
      throw new BrowserRequestError(403, "Browser profile grant was revoked for this conversation");
  }
  if (operation.operation === "start" && operation.args.profileId) {
    if (!browserRuntime().profileUsable(operation.args.profileId, identity.projectId, identity.conversationId)) throw new BrowserRequestError(403, "Browser profile is not granted to this conversation");
  }
  return identity;
}
export async function browserSessionOwner(id: string, actor: BrowserActor, identity?: z.infer<typeof browserIdentitySchema>): Promise<string> {
  idSchema.parse(id);
  const owners: string[] = [], unavailable: string[] = [];
  const local = await getClusterNode();
  try { await localBrowserOperation({ operation: "get", args: { id } }, actor); owners.push(local.id); }
  catch (error) { if (!(error instanceof Error) || error.message !== "Browser session not found") throw error; }
  await Promise.all((await listRuntimePeers()).map(async peer => {
    try {
      await (await peerRequest(peer.id, "operation", { operation: "get", args: { id }, actor, identity }, 5000)).json();
      owners.push(peer.id);
    } catch (error) {
      if (error instanceof BrowserRequestError && ((error.status === 404 && error.message === "Browser session not found") || (error.status === 403 && (/Project is not shared/.test(error.message) || /restricted to this node/.test(error.message))))) return;
      unavailable.push(peer.id);
    }
  }));
  if (owners.length > 1) throw new BrowserRequestError(409, "Browser session ID has multiple physical owners");
  if (owners.length === 1) return owners[0];
  if (unavailable.length) throw new BrowserRequestError(503, `Browser session owner unavailable: ${unavailable.join(", ")}. No other account was selected.`);
  throw new BrowserRequestError(404, "Browser session not found");
}
export async function browserDownload(id: string, downloadId: string, nodeId: string, identity?: z.infer<typeof browserIdentitySchema>): Promise<{ stream: Readable; name: string }> {
  idSchema.parse(id); idSchema.parse(downloadId);
  if (idSchema.parse(nodeId) === (await getClusterNode()).id) {
    if (identity) await authorizeBrowserAgent({ operation: "get", args: { id } }, identity);
    const file = await browserRuntime().download(id, downloadId);
    return { stream: createReadStream(file.path), name: file.name };
  }
  const response = await peerRequest(nodeId, "download", { id, downloadId, identity }, 120000);
  if (!response.body) throw new BrowserRequestError(502, "Browser download has no content");
  return { stream: Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>), name: decodeURIComponent(response.headers.get("x-browser-filename") || "download") };
}

export async function attachBrowserViewer(socket: WebSocket, url: URL, actor: BrowserActor, machineNodeId?: string) {
  try {
    const id = idSchema.parse(url.searchParams.get("browserSessionId"));
    if (machineNodeId) {
      const session = await browserRuntime().get(id);
      if (!(await clusterPeerMayAccessProject(machineNodeId, session.projectId))) throw Error("Project is not shared");
      if (browserRuntime().profileOrNull(session.profileId)?.crossNodeAccess === false) throw Error("Browser profile is restricted to this node");
      trackRuntimeSocket(socket,machineNodeId,session.projectId);
      await browserRuntime().attachViewer(id, socket, actor, true); return;
    }
    const nodeId = idSchema.optional().parse(url.searchParams.get("nodeId") ?? undefined) ?? await browserSessionOwner(id, actor);
    if (nodeId === (await getClusterNode()).id) { await browserRuntime().attachViewer(id, socket, actor, false); return; }
    const peer = await getRuntimePeer(nodeId);
    if (!peer) throw Error("Browser node unavailable");
    const remote = new URL("/ws", peer.url); remote.protocol = remote.protocol === "https:" ? "wss:" : "ws:";
    remote.search = new URLSearchParams({ mode: "browser", browserSessionId: id, controllerId: actor.kind === "human" ? actor.id : "agent" }).toString();
    const upstream = new WebSocket(remote, { headers: await runtimeSocketHeaders(peer.id,remote), handshakeTimeout: 10000, maxPayload: 32 * 1024 * 1024 });
    const queued: Buffer[] = []; let queuedBytes = 0;
    socket.on("message", data => {
      const buffer = Buffer.from(data as Buffer);
      if (upstream.readyState === WebSocket.OPEN) { if (upstream.bufferedAmount > 32 * 1024 * 1024) { socket.close(1009); return; } upstream.send(buffer); }
      else if (upstream.readyState === WebSocket.CONNECTING && (queuedBytes += buffer.length) < 1024 * 1024) queued.push(buffer);
      else socket.close(1009);
    });
    upstream.once("open", () => { if (socket.readyState !== WebSocket.OPEN) { upstream.close(); return; } for (const data of queued) upstream.send(data); queued.length = 0; });
    upstream.on("message", data => { if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 8 * 1024 * 1024) socket.send(data.toString()); });
    socket.once("close", () => upstream.terminate()); upstream.once("close", () => socket.close(1012, "Browser node disconnected; reconnect to resume viewing"));
    upstream.on("error", () => socket.close(1011, "Browser node unavailable")); socket.on("error", () => upstream.terminate());
  } catch (error) { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "browserError", error: error instanceof Error ? error.message : "Browser unavailable" })); socket.close(1008, "Browser session unavailable"); }
}
