import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import WebSocket from "ws";
import { z } from "zod";
import { getClusterNode, getClusterPeer, getClusterMachineToken, listClusterPeers } from "../cluster.js";
import { applyBrowserConfiguration, readBrowserConfiguration, browserConfigurationSchema, applyBrowserPreference, readBrowserPreference, browserPreferenceSchema } from "../browser-configuration.js";
import { browserCapability, BrowserRuntime } from "../browser-runtime.js";
import { browserCommandSchema, browserStartSchema, browserIdentitySchema, browserProfileGrantInputSchema, type BrowserActor, type BrowserProfile, type BrowserSessionView } from "../browser-types.js";
import { enqueueSystemPrompt } from "../prompt-queue.js";
import { getProject } from "../store.js";
import { clusterPeerMayAccessProject } from "./cluster-helpers.js";
import { broadcastToProject, wakeQueuedConversations } from "./realtime.js";

export class BrowserRequestError extends Error { constructor(public status: number, message: string) { super(message); } }
let runtime: BrowserRuntime | undefined;
export function browserRuntime(): BrowserRuntime { return runtime ??= new BrowserRuntime(); }
export async function closeBrowserRuntime(): Promise<void> { await runtime?.close(); runtime = undefined; }
export async function localBrowserStatus() {
  const node = await getClusterNode();
  return { node: { id: node.id, name: node.name }, config: readBrowserConfiguration(), capability: await browserCapability(), runningCount: (await browserRuntime().list()).filter(row => row.state === "running").length };
}
export async function browserStatus(nodeId?: string) {
  if (nodeId && idSchema.parse(nodeId) !== (await getClusterNode()).id) return (await peerRequest(nodeId, "status", {}, 5000)).json();
  const own = await localBrowserStatus();
  const nodes = [{ ...own.node, ...own.capability, reachable: true, runningCount: own.runningCount }];
  nodes.push(...await Promise.all((await listClusterPeers()).map(async peer => {
    try {
      const status = await (await peerRequest(peer.id, "status", {}, 5000)).json() as Awaited<ReturnType<typeof localBrowserStatus>>;
      applyBrowserConfiguration(browserConfigurationSchema.parse(status.config));
      return { id: peer.id, name: peer.name, ...status.capability, reachable: true, runningCount: status.runningCount };
    } catch (error) {
      return { id: peer.id, name: peer.name, supported: false, available: false, executable: null, reachable: false, runningCount: 0, reason: error instanceof Error ? error.message : "Browser node unavailable" };
    }
  })));
  return { ...own, config: readBrowserConfiguration(), nodes };
}
async function knownNode(nodeId: string): Promise<void> {
  idSchema.parse(nodeId);
  if (nodeId !== (await getClusterNode()).id && !(await getClusterPeer(nodeId))) throw new BrowserRequestError(503, "Browser node is no longer paired");
}
export async function configureBrowserExecutor(executorNodeId: string | null) {
  if (executorNodeId) await knownNode(executorNodeId);
  await browserStatus();
  applyBrowserConfiguration({ executorNodeId, originNodeId: (await getClusterNode()).id, updatedAt: nextVersion(readBrowserConfiguration().updatedAt) });
  await Promise.all((await listClusterPeers()).map(async peer => {
    try { await peerRequest(peer.id, "config", readBrowserConfiguration(), 5000); }
    catch (error) { console.warn(`Browser configuration sync to ${peer.id} failed`, error); }
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
    if (update.nodeId) await knownNode(update.nodeId);
    applyBrowserPreference({ ...identity, nodeId: update.nodeId, originNodeId: (await getClusterNode()).id, updatedAt: nextVersion(readBrowserPreference(identity)?.updatedAt) });
    await Promise.all(peers.map(async peer => {
      try { await peerRequest(peer.id, "preferences", { identity, preference: readBrowserPreference(identity) }, 5000); }
      catch (error) { console.warn(`Browser preference sync to ${peer.id} failed`, error); }
    }));
  }
  const preference = readBrowserPreference(identity);
  return { nodeId: preference?.nodeId ?? null, effectiveNodeId: preference?.nodeId ?? readBrowserConfiguration().executorNodeId };
}
async function sharedBrowserPeers(projectId?: string) {
  const peers = await listClusterPeers();
  if (!projectId) return peers;
  return (await Promise.all(peers.map(async peer => await clusterPeerMayAccessProject(peer.id, projectId) ? peer : null))).filter(peer => peer !== null);
}

// Relay browser control only. Website network traffic remains executor-local.
async function peerRequest(peerId: string, route: string, body: unknown, timeout = 60000): Promise<Response> {
  const peer = await getClusterPeer(peerId);
  if (!peer) throw new BrowserRequestError(503, "Browser node is no longer paired");
  let response: Response;
  try {
    response = await fetch(`${peer.url}/api/cluster/browser/${route}`, {
      method: "POST", headers: { Authorization: `Bearer ${await getClusterMachineToken()}`, "Content-Type": "application/json" },
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
      const remote = await (await peerRequest(peer.id, "operation", { ...operation, actor, identity }, 5000)).json() as { sessions: BrowserSessionView[] };
      result.sessions.push(...remote.sessions.map(session => ({ ...session, nodeId: peer.id })));
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
      const remote = await (await peerRequest(peer.id, "operation", { operation: "profiles", args, actor, identity }, 5000)).json() as { profiles: BrowserProfile[] };
      result.profiles.push(...remote.profiles.map(profile => ({ ...profile, nodeId: peer.id })));
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
    if (owner && nodeId && owner !== nodeId) throw new BrowserRequestError(409, `Browser profile belongs to machine ${owner}, not ${nodeId}`);
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
  await Promise.all((await listClusterPeers()).map(async peer => {
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
      await browserRuntime().attachViewer(id, socket, actor, true); return;
    }
    const nodeId = idSchema.optional().parse(url.searchParams.get("nodeId") ?? undefined) ?? await browserSessionOwner(id, actor);
    if (nodeId === (await getClusterNode()).id) { await browserRuntime().attachViewer(id, socket, actor, false); return; }
    const peer = await getClusterPeer(nodeId);
    if (!peer) throw Error("Browser node unavailable");
    const remote = new URL("/ws", peer.url); remote.protocol = remote.protocol === "https:" ? "wss:" : "ws:";
    remote.search = new URLSearchParams({ mode: "browser", browserSessionId: id, controllerId: actor.kind === "human" ? actor.id : "agent" }).toString();
    const upstream = new WebSocket(remote, { headers: { Authorization: `Bearer ${await getClusterMachineToken()}` }, handshakeTimeout: 10000, maxPayload: 32 * 1024 * 1024 });
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
