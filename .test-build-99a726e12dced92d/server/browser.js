import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import WebSocket from "ws";
import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { getRuntimePeer, listRuntimePeers, runtimeFetch, runtimeSocketHeaders, trackRuntimeSocket } from "./runtime-peers.js";
import { applyBrowserClusterDefault, applyBrowserConfiguration, browserClusterDefaultSchema, clearBrowserConfiguration, readBrowserClusterDefault, readBrowserClusterDefaults, readBrowserClusterOverrides, readBrowserConfiguration, readBrowserSessionNodes, recordBrowserSessionNode, setBrowserClusterOverride, applyBrowserPreference, readBrowserPreference, browserPreferenceSchema } from "../browser-configuration.js";
import { getSharingCluster, isTrustedTwin, listSharingClusterMembers, listSharingMemberships } from "../cluster-sharing-policy.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { browserCapability, BrowserRuntime } from "../browser-runtime.js";
import { browserCommandSchema, browserStartSchema, browserIdentitySchema, browserProfileGrantInputSchema } from "../browser-types.js";
import { enqueueSystemPrompt } from "../prompt-queue.js";
import { getProject, listProjects, listWorkspaces } from "../store.js";
import { clusterPeerMayAccessProject } from "./cluster-helpers.js";
import { broadcastToProject, wakeQueuedConversations } from "./realtime.js";
import { isPeerUnreachable } from "./peer-availability.js";
import { peerSnapshot, staleSnapshotReason } from "./peer-snapshots.js";
class BrowserRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
}
let runtime;
function browserRuntime() {
  return runtime ??= new BrowserRuntime();
}
async function closeBrowserRuntime() {
  await runtime?.close();
  runtime = void 0;
}
const unsetBrowserConfiguration = { executorNodeId: null, updatedAt: "1970-01-01T00:00:00.000Z", originNodeId: "00000000-0000-0000-0000-000000000000" };
function clusterMemberIds(db, clusterId) {
  try {
    return listSharingClusterMembers(db, clusterId).map((member) => member.nodeId);
  } catch {
    return [];
  }
}
let browserDefaultVetted = false;
async function vetBrowserDefault() {
  if (browserDefaultVetted) return;
  browserDefaultVetted = true;
  const config = readBrowserConfiguration();
  if (config.executorNodeId !== null && config.originNodeId !== (await getClusterNode()).id) clearBrowserConfiguration();
}
async function acceptBrowserClusterDefault(senderNodeId, input) {
  const value = browserClusterDefaultSchema.parse(input), db = await clusterV2Database(), local = (await getClusterNode()).id;
  const members = clusterMemberIds(db, value.clusterId);
  if (![local, senderNodeId, value.originNodeId].every((node) => members.includes(node))) return false;
  if (value.executorNodeId && !members.includes(value.executorNodeId)) return false;
  applyBrowserClusterDefault(value);
  return true;
}
async function localBrowserStatus(callerNodeId) {
  await vetBrowserDefault();
  const node = await getClusterNode(), db = await clusterV2Database();
  const shared = (clusterId) => !callerNodeId || clusterMemberIds(db, clusterId).includes(callerNodeId);
  return {
    node: { id: node.id, name: node.name },
    config: callerNodeId ? unsetBrowserConfiguration : readBrowserConfiguration(),
    clusterDefaults: readBrowserClusterDefaults().filter((entry) => shared(entry.clusterId) && clusterMemberIds(db, entry.clusterId).includes(node.id)),
    capability: await browserCapability(),
    runningCount: (await browserRuntime().list()).filter((row) => row.state === "running").length
  };
}
async function memberClusterIds() {
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  try {
    return listSharingMemberships(db, local).map(({ clusterId }) => clusterId);
  } catch {
    return [];
  }
}
async function browserClusters() {
  const db = await clusterV2Database(), overrides = readBrowserClusterOverrides();
  return (await memberClusterIds()).flatMap((clusterId) => {
    try {
      return [{
        id: clusterId,
        name: getSharingCluster(db, clusterId).name,
        memberNodeIds: clusterMemberIds(db, clusterId),
        executorNodeId: readBrowserClusterDefault(clusterId)?.executorNodeId ?? null,
        overrideNodeId: overrides.find((entry) => entry.clusterId === clusterId)?.executorNodeId ?? null
      }];
    } catch {
      return [];
    }
  });
}
async function browserDefault(projectId) {
  await vetBrowserDefault();
  const members = new Set(await memberClusterIds());
  const clusters = new Set(((projectId ? (await getProject(projectId))?.clusterIds : void 0) ?? []).filter((clusterId) => members.has(clusterId)));
  const latest = (entries) => entries.filter((entry) => entry.executorNodeId && clusters.has(entry.clusterId)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  const override = latest(readBrowserClusterOverrides());
  if (override) return { nodeId: override.executorNodeId, source: "override", clusterId: override.clusterId };
  const suggestion = latest(readBrowserClusterDefaults());
  if (suggestion) return { nodeId: suggestion.executorNodeId, source: "cluster", clusterId: suggestion.clusterId };
  const own = readBrowserConfiguration().executorNodeId;
  return own ? { nodeId: own, source: "machine" } : { nodeId: null, source: null };
}
async function browserStatus(nodeId, projectId) {
  if (nodeId && idSchema.parse(nodeId) !== (await getClusterNode()).id) return (await peerRequest(nodeId, "status", {}, 5e3)).json();
  const project = projectId ? await getProject(projectId) : void 0;
  if (projectId && !project) throw new BrowserRequestError(404, "Project not found");
  const own = await localBrowserStatus();
  const nodes = [{ ...own.node, ...own.capability, reachable: true, runningCount: own.runningCount }];
  nodes.push(...await Promise.all((await listRuntimePeers(project?.id)).map(async (peer) => {
    let status;
    try {
      status = await (await peerRequest(peer.id, "status", {}, 5e3)).json();
    } catch (error) {
      return { id: peer.id, name: peer.name, supported: false, available: false, executable: null, reachable: false, runningCount: 0, reason: error instanceof Error ? error.message : "Browser node unavailable" };
    }
    for (const entry of status.clusterDefaults ?? []) await acceptBrowserClusterDefault(peer.id, entry).catch(() => false);
    return { id: peer.id, name: peer.name, ...status.capability, reachable: true, runningCount: status.runningCount };
  })));
  return { ...own, config: readBrowserConfiguration(), clusterDefaults: readBrowserClusterDefaults(), clusters: await browserClusters(), default: await browserDefault(project?.id), nodes };
}
async function knownNode(nodeId) {
  idSchema.parse(nodeId);
  if (nodeId !== (await getClusterNode()).id && !await getRuntimePeer(nodeId)) throw new BrowserRequestError(503, "Browser node is no longer paired");
}
async function configureBrowserExecutor(executorNodeId) {
  if (executorNodeId) await knownNode(executorNodeId);
  await vetBrowserDefault();
  applyBrowserConfiguration({ executorNodeId, originNodeId: (await getClusterNode()).id, updatedAt: nextVersion(readBrowserConfiguration().updatedAt) });
  return browserStatus();
}
async function configureClusterBrowserOverride(clusterId, executorNodeId) {
  idSchema.parse(clusterId);
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  const members = clusterMemberIds(db, clusterId);
  if (!members.includes(local)) throw new BrowserRequestError(404, "This machine is not a member of that cluster");
  if (executorNodeId && !members.includes(executorNodeId)) throw new BrowserRequestError(400, "That machine is not a member of this cluster");
  setBrowserClusterOverride(clusterId, executorNodeId);
  return browserStatus();
}
async function configureClusterBrowserDefault(clusterId, executorNodeId) {
  idSchema.parse(clusterId);
  await browserStatus();
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  const members = clusterMemberIds(db, clusterId);
  if (!members.includes(local)) throw new BrowserRequestError(404, "This machine is not a member of that cluster");
  if (executorNodeId && !members.includes(executorNodeId)) throw new BrowserRequestError(400, "That machine is not a member of this cluster");
  applyBrowserClusterDefault({ clusterId, executorNodeId, originNodeId: local, updatedAt: nextVersion(readBrowserClusterDefault(clusterId)?.updatedAt) });
  const value = readBrowserClusterDefault(clusterId);
  await Promise.all((await listRuntimePeers()).filter((peer) => members.includes(peer.id)).map(async (peer) => {
    try {
      await peerRequest(peer.id, "cluster-default", value, 5e3);
    } catch (error) {
      console.warn(`Browser cluster default sync to ${peer.id} failed`, error);
    }
  }));
  return browserStatus();
}
function nextVersion(previous) {
  return new Date(Math.max(Date.now(), previous ? Date.parse(previous) + 1 : 0)).toISOString();
}
async function canonicalBrowserIdentity(input) {
  const identity = browserIdentitySchema.parse(input);
  const project = await getProject(identity.projectId);
  if (!project) throw new BrowserRequestError(404, "Project not found");
  return { ...identity, projectId: project.id };
}
async function browserPreferences(input, update) {
  const identity = await canonicalBrowserIdentity(input);
  await browserStatus();
  const peers = await sharedBrowserPeers(identity.projectId);
  await Promise.all(peers.map(async (peer) => {
    try {
      const result = await (await peerRequest(peer.id, "preferences", { identity, preference: readBrowserPreference(identity) }, 5e3)).json();
      if (result.preference) applyBrowserPreference({ ...browserPreferenceSchema.parse(result.preference), ...identity });
    } catch (error) {
      console.warn(`Browser preference sync to ${peer.id} failed`, error);
    }
  }));
  if (update) {
    if (update.nodeId) {
      await knownNode(update.nodeId);
      if (update.nodeId !== (await getClusterNode()).id && !await clusterPeerMayAccessProject(update.nodeId, identity.projectId)) throw new BrowserRequestError(403, "This project is not shared with that machine");
    }
    applyBrowserPreference({ ...identity, nodeId: update.nodeId, originNodeId: (await getClusterNode()).id, updatedAt: nextVersion(readBrowserPreference(identity)?.updatedAt) });
    await Promise.all(peers.map(async (peer) => {
      try {
        await peerRequest(peer.id, "preferences", { identity, preference: readBrowserPreference(identity) }, 5e3);
      } catch (error) {
        console.warn(`Browser preference sync to ${peer.id} failed`, error);
      }
    }));
  }
  const preference = readBrowserPreference(identity);
  const fallback = await browserDefault(identity.projectId);
  return { nodeId: preference?.nodeId ?? null, effectiveNodeId: preference?.nodeId ?? fallback.nodeId, defaultNodeId: fallback.nodeId, defaultSource: fallback.source };
}
async function sharedBrowserPeers(projectId) {
  const peers = await listRuntimePeers();
  if (!projectId) return peers;
  return (await Promise.all(peers.map(async (peer) => await clusterPeerMayAccessProject(peer.id, projectId) ? peer : null))).filter((peer) => peer !== null);
}
function browserPeerUnreachable(error) {
  return error instanceof BrowserRequestError ? error.status === 503 : isPeerUnreachable(error);
}
async function peerRequest(peerId, route, body, timeout = 6e4) {
  const peer = await getRuntimePeer(peerId);
  if (!peer) throw new BrowserRequestError(503, "Browser node is no longer paired");
  let response;
  try {
    response = await runtimeFetch(`${peer.url}/api/cluster/browser/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout)
    });
  } catch {
    throw new BrowserRequestError(503, "Browser node is unreachable. Its browser is not moved to another node.");
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new BrowserRequestError(response.status, error.error || `Browser node returned ${response.status}`);
  }
  return response;
}
const idSchema = z.string().uuid();
const profileAccessContextSchema = z.object({ id: idSchema, projectId: z.string().min(1).max(200), conversationId: z.string().min(1).max(200).optional() });
const profileAccessUpdateSchema = z.object({
  grant: browserProfileGrantInputSchema.optional(),
  revoke: browserProfileGrantInputSchema.optional()
}).strict().refine(
  (update) => [update.grant, update.revoke].filter((value) => value !== void 0).length <= 1,
  "Send one profile access change per request; an empty body reads the current access"
);
const profileChangeSchema = z.union([
  z.object({ grant: browserProfileGrantInputSchema }).strict(),
  z.object({ revoke: browserProfileGrantInputSchema }).strict(),
  z.object({ label: z.string().trim().min(1).max(80) }).strict(),
  z.object({ close: z.literal(true) }).strict(),
  z.object({ delete: z.literal(true) }).strict()
]);
const workspaceIdSchema = z.string().min(1).max(200);
const browserOperationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("start"), args: browserStartSchema }),
  z.object({ operation: z.literal("list"), args: browserIdentitySchema.partial() }),
  z.object({ operation: z.literal("get"), args: z.object({ id: idSchema }) }),
  z.object({ operation: z.literal("forget"), args: z.object({ id: idSchema }) }),
  z.object({ operation: z.literal("command"), args: z.object({ id: idSchema, command: browserCommandSchema }) }),
  z.object({ operation: z.literal("profiles"), args: z.object({ projectId: z.string().min(1).max(200), conversationId: z.string().min(1).max(200).optional(), workspaceId: workspaceIdSchema.optional() }) }),
  z.object({ operation: z.literal("deleteProfile"), args: profileAccessContextSchema }),
  z.object({ operation: z.literal("profileAccess"), args: profileAccessContextSchema.extend({ update: profileAccessUpdateSchema }) }),
  z.object({ operation: z.literal("directory"), args: z.object({ projectIds: z.array(z.string().min(1).max(200)).max(2e3) }) }),
  z.object({ operation: z.literal("manageProfile"), args: z.object({ id: idSchema, change: profileChangeSchema }) })
]);
function trustedTwin(db, local, nodeId) {
  try {
    return isTrustedTwin(db, local, nodeId);
  } catch {
    return false;
  }
}
async function grantReachesNode(grant, nodeId, projectIds) {
  switch (grant.scope) {
    case "node":
    case "workspace":
      return grant.nodeId === nodeId;
    case "cluster": {
      const db = await clusterV2Database(), members = clusterMemberIds(db, grant.clusterId);
      return members.includes(nodeId) && members.includes((await getClusterNode()).id);
    }
    default: {
      if (grant.nodeId && grant.nodeId !== nodeId) return false;
      if (grant.scope === "conversation" && !grant.nodeId && grant.originNodeId) return grant.originNodeId === nodeId;
      if (projectIds && !projectIds.has(grant.projectId)) return false;
      const project = await getProject(grant.projectId);
      return !project || await clusterPeerMayAccessProject(nodeId, project.id);
    }
  }
}
async function reachingGrants(grants, nodeId, projectIds) {
  const reached = await Promise.all(grants.map(async (grant) => await grantReachesNode(grant, nodeId, projectIds) ? grant : null));
  return reached.filter((grant) => grant !== null);
}
async function relayedSessionAllowed(machineNodeId, session) {
  if ((session.accessNodeId ?? session.appNodeId) === machineNodeId) return true;
  const project = await getProject(session.projectId);
  if (!project || !await clusterPeerMayAccessProject(machineNodeId, project.id)) return false;
  return !session.profileId || browserRuntime().profileUsable(session.profileId, { nodeId: machineNodeId, projectId: session.projectId, conversationId: session.conversationId });
}
const notSharedWithNode = "Browser session is not shared with this node";
async function normalizeGrant(grant, local) {
  const value = { ...grant };
  if (value.projectId) value.projectId = (await getProject(value.projectId))?.id ?? value.projectId;
  if (value.nodeId && value.nodeId !== local && !await getRuntimePeer(value.nodeId)) throw new BrowserRequestError(400, "That machine is not paired with this one");
  if (value.clusterId && !clusterMemberIds(await clusterV2Database(), value.clusterId).includes(local)) throw new BrowserRequestError(400, "This machine is not a member of that cluster");
  return value;
}
async function localBrowserOperation(input, actor, machineNodeId, agentIdentity) {
  const operation = browserOperationSchema.parse(input);
  const local = await getClusterNode();
  const service = browserRuntime();
  const db = await clusterV2Database();
  const view = (session) => ({ ...session, nodeId: local.id });
  const callerNodeId = machineNodeId ?? local.id;
  const assertManager = async (profile) => {
    if (!machineNodeId) return;
    if (actor.kind !== "human" || !trustedTwin(db, local.id, machineNodeId) || !(await reachingGrants(service.profileGrants(profile.id), machineNodeId, null)).length)
      throw new BrowserRequestError(403, "Only this profile's machine and its twins can manage it");
  };
  const visibleGrants = async (grants, access) => {
    if (!grants) return grants;
    const agentScope = agentIdentity ?? (actor.kind === "agent" ? access : void 0);
    if (agentScope) return grants.filter((grant) => grant.scope === "cluster" || (grant.scope === "node" || grant.scope === "workspace") && grant.nodeId === callerNodeId || grant.projectId === agentScope.projectId && (grant.scope !== "conversation" || grant.conversationId === agentScope.conversationId));
    if (!machineNodeId || trustedTwin(db, local.id, machineNodeId)) return grants;
    return reachingGrants(grants, machineNodeId, null);
  };
  let foreignProject = false;
  if ("projectId" in operation.args && operation.args.projectId) {
    const project = await getProject(operation.args.projectId);
    if (project) {
      if (machineNodeId && !await clusterPeerMayAccessProject(machineNodeId, project.id)) throw new BrowserRequestError(403, "Project is not shared with this node");
      operation.args.projectId = project.id;
    } else if (machineNodeId && ["start", "list", "profiles"].includes(operation.operation)) foreignProject = true;
    else throw new BrowserRequestError(404, "Project not found on browser node");
  }
  const assertAgentSession = async (id, exemptClose = false) => {
    const session = await service.get(id);
    if (machineNodeId && !await relayedSessionAllowed(machineNodeId, session)) throw new BrowserRequestError(403, notSharedWithNode);
    if (agentIdentity) {
      if (session.projectId !== agentIdentity.projectId || session.conversationId !== agentIdentity.conversationId)
        throw new BrowserRequestError(403, "Browser is not attached to this conversation");
      if (session.profileId && !exemptClose && !service.profileUsable(session.profileId, service.sessionAccess(session)))
        throw new BrowserRequestError(403, "Browser profile grant was revoked for this conversation");
    }
    return session;
  };
  const assertManageable = (profile, projectId, conversationId) => {
    if (profile.projectId === projectId || service.profileUsable(profile.id, { nodeId: callerNodeId, projectId, conversationId })) return;
    throw new BrowserRequestError(403, "Browser profile cannot be managed from this project");
  };
  const profileState = (profileId, projectId, conversationId) => {
    const holder = service.profileHolder(profileId);
    if (!holder) return "idle";
    return holder.projectId === projectId && holder.conversationId === conversationId ? "open-here" : "in-use";
  };
  switch (operation.operation) {
    case "start": {
      await knownNode(operation.args.appNodeId);
      if (foreignProject && operation.args.appNodeId !== machineNodeId) throw new BrowserRequestError(403, "Project is not shared with this node");
      const accessNodeId = callerNodeId;
      const workspaceId = machineNodeId ? operation.args.appNodeId === machineNodeId ? operation.args.workspaceId : void 0 : (await getProject(operation.args.projectId))?.type;
      const args = { ...operation.args, workspaceId: workspaceId || void 0 };
      if (args.profileId) {
        service.profile(args.profileId);
        if (!service.profileUsable(args.profileId, { nodeId: accessNodeId, projectId: args.projectId, conversationId: args.conversationId, workspaceId: args.workspaceId ?? null }))
          throw new BrowserRequestError(403, "Browser profile is not granted to this conversation");
      }
      return { session: view(await service.create(args, actor.kind === "agent" ? actor.credentialOrigins ?? [] : [], { accessNodeId })) };
    }
    case "list": {
      const sessions = (await service.list(operation.args)).map(view);
      const redacted = sessions.map((session) => actor.kind === "agent" && session.profileId && !service.profileUsable(session.profileId, service.sessionAccess(session)) ? { ...session, tabs: [], activePageId: null, loginRequest: null, downloads: [], fileChooser: false, fileChooserRequest: null, dialog: null, accessRevoked: true } : session);
      const allowed = machineNodeId ? await Promise.all(redacted.map(async (session) => await relayedSessionAllowed(machineNodeId, session) ? session : null)) : redacted;
      return { sessions: allowed.filter(Boolean) };
    }
    case "get": {
      const session = await assertAgentSession(operation.args.id);
      return { session: view(session) };
    }
    case "forget": {
      const session = await assertAgentSession(operation.args.id);
      await service.forget(operation.args.id);
      return { forgotten: true, projectId: session.projectId };
    }
    case "command": {
      await assertAgentSession(operation.args.id, operation.args.command.action === "close");
      const result = await service.execute(operation.args.id, operation.args.command, actor, Boolean(machineNodeId));
      const updated = view(await service.get(operation.args.id));
      if (operation.args.command.action === "completeLogin") announceBrowserLoginCompleted(updated, operation.args.command.requestId);
      return { result, session: updated };
    }
    case "profiles": {
      const { projectId, conversationId } = operation.args;
      const workspaceId = machineNodeId ? operation.args.workspaceId ?? null : (await getProject(projectId))?.type ?? null;
      const profiles = await service.usableProfiles({ nodeId: callerNodeId, projectId, conversationId, workspaceId });
      const dormant = !machineNodeId && actor.kind === "human" && !foreignProject ? (await service.profiles(projectId)).filter((profile) => !profiles.some((visible) => visible.id === profile.id)).map((profile) => ({ ...profile, grants: service.profileGrants(profile.id) })) : [];
      return { profiles: await Promise.all([...profiles, ...dormant].map(async (profile) => ({ ...profile, grants: await visibleGrants(profile.grants, { projectId, conversationId }), nodeId: local.id, state: profileState(profile.id, projectId, conversationId) }))) };
    }
    case "deleteProfile": {
      const profile = service.profile(operation.args.id);
      await assertManager(profile);
      assertManageable(profile, operation.args.projectId);
      await service.deleteProfile(operation.args.id, profile.projectId);
      return { deleted: true };
    }
    case "profileAccess": {
      const profile = service.profile(operation.args.id);
      assertManageable(profile, operation.args.projectId, operation.args.conversationId);
      const update = operation.args.update;
      if (update.grant || update.revoke) await assertManager(profile);
      if (update.grant) service.grantProfileAccess(operation.args.id, await normalizeGrant(update.grant, local.id), callerNodeId);
      if (update.revoke) service.revokeProfileAccess(operation.args.id, await normalizeGrant(update.revoke, local.id).catch(() => update.revoke));
      return { profile: { ...service.profile(operation.args.id), grants: await visibleGrants(service.profileGrants(operation.args.id)), nodeId: local.id } };
    }
    case "directory": {
      if (actor.kind !== "human") throw new BrowserRequestError(403, "Only people can list every browser profile");
      const manager = !machineNodeId || trustedTwin(db, local.id, machineNodeId);
      const projectIds = machineNodeId ? new Set(operation.args.projectIds) : null;
      const entries = [];
      for (const profile of service.allProfiles()) {
        const grants = profile.grants ?? [];
        const reaching = machineNodeId ? await reachingGrants(grants, machineNodeId, projectIds) : grants;
        if (machineNodeId && !reaching.length) continue;
        const holder = service.profileHolder(profile.id);
        entries.push({
          ...profile,
          nodeId: local.id,
          grants: manager ? grants : reaching,
          canManage: manager,
          holder: holder ? manager ? { sessionId: holder.id, projectId: holder.projectId, engine: holder.engine, conversationId: holder.conversationId, appNodeId: holder.accessNodeId ?? holder.appNodeId, state: holder.state } : { inUse: true } : null
        });
      }
      return { profiles: entries };
    }
    case "manageProfile": {
      if (actor.kind !== "human") throw new BrowserRequestError(403, "Agents cannot manage browser profiles");
      const profile = service.profile(operation.args.id);
      await assertManager(profile);
      const change = operation.args.change;
      if ("grant" in change) service.grantProfileAccess(profile.id, await normalizeGrant(change.grant, local.id), callerNodeId);
      else if ("revoke" in change) service.revokeProfileAccess(profile.id, await normalizeGrant(change.revoke, local.id).catch(() => change.revoke));
      else if ("label" in change) service.renameProfile(profile.id, change.label);
      else if ("close" in change) await service.closeProfileSessions(profile.id);
      else {
        await service.deleteProfile(profile.id, profile.projectId);
        return { deleted: true };
      }
      return { profile: { ...service.profile(profile.id), grants: service.profileGrants(profile.id), nodeId: local.id } };
    }
  }
}
function announceBrowserLoginCompleted(session, requestId) {
  try {
    enqueueSystemPrompt(
      `${session.projectId}:${session.conversationId}`,
      requestId,
      `Browser sign-in completed: the human finished signing in on "${session.profileLabel || "the browser"}" and chose Done, returning control to the agent. Re-inspect the signed-in page state, then continue the paused browser task.`
    );
    wakeQueuedConversations();
  } catch (error) {
    console.warn("Browser login continuation prompt failed", error);
  }
}
function requireCompleteDiscovery(discovery) {
  if (discovery.unavailableNodes.length) throw new BrowserRequestError(503, `Browser attachment discovery incomplete: ${discovery.unavailableNodes.map((node) => `${node.nodeId}: ${node.reason}`).join("; ")}. No account was selected or created.`);
}
async function browserOperation(input, actor, nodeId, identity) {
  const operation = browserOperationSchema.parse(input);
  if (operation.operation === "list" && !nodeId) return discoverBrowsers(operation, actor, identity);
  if (operation.operation === "start") {
    const result2 = await startBrowser(operation, actor, nodeId, identity);
    broadcastToProject(operation.args.projectId, { type: "browserSessionsChanged" });
    return result2;
  }
  if (!nodeId && (operation.operation === "get" || operation.operation === "command" || operation.operation === "forget")) nodeId = await browserSessionOwner(operation.args.id, actor, identity);
  if (!nodeId || idSchema.parse(nodeId) === (await getClusterNode()).id) {
    const result2 = await localBrowserOperation(operation, actor, void 0, actor.kind === "agent" ? identity : void 0);
    if (operation.operation === "forget") broadcastToProject(result2.projectId, { type: "browserSessionsChanged" });
    return result2;
  }
  const result = await (await peerRequest(nodeId, "operation", { ...operation, actor, identity })).json();
  if (operation.operation === "forget") broadcastToProject(result.projectId, { type: "browserSessionsChanged" });
  return result;
}
async function sessionPeers(projectId, conversationId) {
  const peers = await sharedBrowserPeers(projectId);
  if (!projectId) return peers;
  const recorded = readBrowserSessionNodes(projectId, conversationId).filter((nodeId) => !peers.some((peer) => peer.id === nodeId));
  const extra = await Promise.all(recorded.map((nodeId) => getRuntimePeer(nodeId)));
  return [...peers, ...extra.filter((peer) => Boolean(peer))];
}
async function discoverBrowsers(operation, actor, identity) {
  const local = await localBrowserOperation(operation, actor);
  const result = { sessions: local.sessions, unavailableNodes: [] };
  await Promise.all((await sessionPeers(operation.args.projectId, operation.args.conversationId)).map(async (peer) => {
    try {
      const remote = await peerSnapshot(
        `browser:${JSON.stringify([operation, actor, identity ?? null])}`,
        peer.id,
        async () => await (await peerRequest(peer.id, "operation", { ...operation, actor, identity }, 5e3)).json(),
        { unreachable: browserPeerUnreachable }
      );
      result.sessions.push(...remote.value.sessions.map((session) => ({ ...session, nodeId: peer.id })));
      if (!remote.fresh) result.unavailableNodes.push({ nodeId: peer.id, reason: staleSnapshotReason(remote.fetchedAt) });
    } catch (error) {
      if (error instanceof BrowserRequestError && (error.status === 403 && /Project is not shared/.test(error.message) || error.status === 404 && /Project not found/.test(error.message))) return;
      result.unavailableNodes.push({ nodeId: peer.id, reason: error instanceof Error ? error.message : "Browser node unavailable" });
    }
  }));
  return result;
}
async function discoverBrowserProfiles(identity, actor, options = {}) {
  const workspaceId = (await getProject(identity.projectId))?.type;
  const args = { projectId: identity.projectId, ...options.conversationScoped === false ? {} : { conversationId: identity.conversationId }, ...workspaceId ? { workspaceId } : {} };
  const localNode = await getClusterNode();
  const local = await localBrowserOperation({ operation: "profiles", args }, actor);
  const result = { sessions: [], unavailableNodes: [], profiles: local.profiles.map((profile) => ({ ...profile, nodeId: localNode.id })) };
  await Promise.all((await listRuntimePeers()).map(async (peer) => {
    try {
      const remote = await peerSnapshot(
        `browser-profiles:${JSON.stringify([args, actor, identity])}`,
        peer.id,
        async () => await (await peerRequest(peer.id, "operation", { operation: "profiles", args, actor, identity }, 5e3)).json(),
        // Attaching refuses to pick an account while any node is unaccounted for, so a slow
        // peer keeps its full answer time here; a peer known to be down still fails at once.
        { unreachable: browserPeerUnreachable, waitMs: 5e3 }
      );
      result.profiles.push(...remote.value.profiles.map((profile) => ({ ...profile, nodeId: peer.id })));
      if (!remote.fresh) result.unavailableNodes.push({ nodeId: peer.id, reason: staleSnapshotReason(remote.fetchedAt) });
    } catch (error) {
      if (error instanceof BrowserRequestError && (error.status === 403 && /Project is not shared/.test(error.message) || error.status === 404 && /Project not found/.test(error.message))) return;
      result.unavailableNodes.push({ nodeId: peer.id, reason: error instanceof Error ? error.message : "Browser node unavailable" });
    }
  }));
  return result;
}
async function startBrowser(operation, actor, nodeId, identity) {
  const scope = browserIdentitySchema.parse(operation.args);
  const workspaceId = (await getProject(scope.projectId))?.type;
  operation = { ...operation, args: { ...operation.args, workspaceId: workspaceId || void 0 } };
  if (operation.args.profileId) {
    const listed = await discoverBrowsers({ operation: "list", args: scope }, actor, identity);
    const attached = listed.sessions.filter((session) => session.profileId === operation.args.profileId);
    const owners = new Set(attached.map((session) => session.nodeId));
    if (owners.size > 1) throw new BrowserRequestError(409, "Browser profile has multiple physical owners");
    const owner = attached[0]?.nodeId;
    if (owner && nodeId && owner !== nodeId) {
      if (listed.unavailableNodes.some((node) => node.nodeId === owner)) throw new BrowserRequestError(503, `Browser machine ${owner} is unavailable; no fallback was attempted`);
      throw new BrowserRequestError(409, `Browser profile belongs to machine ${owner}, not ${nodeId}`);
    }
    if (owner) nodeId = owner;
    else {
      if (nodeId === (await getClusterNode()).id && !browserRuntime().profileOrNull(operation.args.profileId)) requireCompleteDiscovery(listed);
      if (!nodeId) {
        requireCompleteDiscovery(listed);
        if (browserRuntime().profileOrNull(operation.args.profileId)) nodeId = (await getClusterNode()).id;
        else {
          const scoped = await discoverBrowserProfiles(scope, actor);
          let holder = scoped.profiles.find((profile) => profile.id === operation.args.profileId);
          if (!holder) {
            requireCompleteDiscovery(scoped);
            const unscoped = await discoverBrowserProfiles(scope, actor, { conversationScoped: false });
            holder = unscoped.profiles.find((profile) => profile.id === operation.args.profileId);
            if (!holder) requireCompleteDiscovery(unscoped);
          }
          if (!holder) throw new BrowserRequestError(404, "Browser profile not found on any paired browser machine");
          nodeId = holder.nodeId;
        }
      }
    }
  } else if (!nodeId) nodeId = (await browserPreferences(scope)).effectiveNodeId ?? void 0;
  if (!nodeId) throw new BrowserRequestError(409, "Choose a browser machine in Settings first");
  await knownNode(nodeId);
  if (nodeId === (await getClusterNode()).id) return localBrowserOperation(operation, actor);
  const result = await (await peerRequest(nodeId, "operation", { ...operation, actor, identity })).json();
  recordBrowserSessionNode(scope.projectId, scope.conversationId, nodeId);
  return result;
}
async function authorizeBrowserAgent(operation, input, machineNodeId) {
  const parsed = browserIdentitySchema.parse(input);
  const known = await getProject(parsed.projectId);
  if (!known && !machineNodeId) throw new BrowserRequestError(404, "Project not found");
  const identity = { ...parsed, projectId: known?.id ?? parsed.projectId };
  const accessNodeId = machineNodeId ?? (await getClusterNode()).id;
  if ("projectId" in operation.args) {
    const project = await getProject(operation.args.projectId);
    if ((project?.id ?? operation.args.projectId) !== identity.projectId) throw new BrowserRequestError(403, "Browser project does not match agent identity");
  }
  if (operation.operation === "deleteProfile" || operation.operation === "profileAccess" || operation.operation === "manageProfile" || operation.operation === "directory") throw new BrowserRequestError(403, "Agents cannot manage browser profiles");
  if (operation.operation === "list" || operation.operation === "start") {
    if (operation.args.engine !== identity.engine || operation.args.conversationId !== identity.conversationId) throw new BrowserRequestError(403, "Browser conversation does not match agent identity");
  }
  if (operation.operation === "get" || operation.operation === "command") {
    const session = await browserRuntime().get(operation.args.id);
    if (session.projectId !== identity.projectId || session.conversationId !== identity.conversationId) throw new BrowserRequestError(403, "Browser is not attached to this conversation");
    if (session.profileId && !(operation.operation === "command" && operation.args.command.action === "close") && !browserRuntime().profileUsable(session.profileId, browserRuntime().sessionAccess(session)))
      throw new BrowserRequestError(403, "Browser profile grant was revoked for this conversation");
  }
  if (operation.operation === "start" && operation.args.profileId) {
    const workspaceId = machineNodeId ? operation.args.workspaceId ?? null : known?.type ?? null;
    if (!browserRuntime().profileUsable(operation.args.profileId, { nodeId: accessNodeId, projectId: identity.projectId, conversationId: identity.conversationId, workspaceId })) throw new BrowserRequestError(403, "Browser profile is not granted to this conversation");
  }
  return identity;
}
async function browserProfileDirectory(actor) {
  const local = await getClusterNode();
  const projectIds = (await listProjects()).map((project) => project.id);
  const own = await localBrowserOperation({ operation: "directory", args: { projectIds } }, actor);
  const result = { profiles: own.profiles.map((profile) => ({ ...profile, nodeName: local.name })), unavailableNodes: [] };
  await Promise.all((await listRuntimePeers()).map(async (peer) => {
    try {
      const remote = await peerSnapshot(
        `browser-directory:${JSON.stringify([actor, projectIds])}`,
        peer.id,
        async () => await (await peerRequest(peer.id, "operation", { operation: "directory", args: { projectIds }, actor }, 5e3)).json(),
        { unreachable: browserPeerUnreachable }
      );
      result.profiles.push(...remote.value.profiles.map((profile) => ({ ...profile, nodeId: peer.id, nodeName: peer.name })));
      if (!remote.fresh) result.unavailableNodes.push({ nodeId: peer.id, name: peer.name, reason: staleSnapshotReason(remote.fetchedAt) });
    } catch (error) {
      result.unavailableNodes.push({ nodeId: peer.id, name: peer.name, reason: error instanceof Error ? error.message : "Browser node unavailable" });
    }
  }));
  return result;
}
async function manageBrowserProfile(nodeId, id, change, actor) {
  const operation = { operation: "manageProfile", args: { id: idSchema.parse(id), change: profileChangeSchema.parse(change) } };
  if (idSchema.parse(nodeId) === (await getClusterNode()).id) return localBrowserOperation(operation, actor);
  await knownNode(nodeId);
  return (await peerRequest(nodeId, "operation", { ...operation, actor })).json();
}
async function browserShareTargets() {
  const local = await getClusterNode(), db = await clusterV2Database();
  const peers = await listRuntimePeers();
  const names = new Map([[local.id, local.name], ...peers.map((peer) => [peer.id, peer.name])]);
  const clusters = (await memberClusterIds()).flatMap((clusterId) => {
    try {
      return [{ id: clusterId, name: getSharingCluster(db, clusterId).name, nodes: clusterMemberIds(db, clusterId).map((id) => ({ id, name: names.get(id) ?? id })) }];
    } catch {
      return [];
    }
  });
  return { localNodeId: local.id, nodes: [...names].map(([id, name]) => ({ id, name })), clusters, workspaces: (await listWorkspaces()).map((workspace) => ({ id: workspace.id, label: workspace.label })) };
}
async function browserSessionOwner(id, actor, identity) {
  idSchema.parse(id);
  const owners = [], unavailable = [];
  const local = await getClusterNode();
  try {
    await localBrowserOperation({ operation: "get", args: { id } }, actor);
    owners.push(local.id);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Browser session not found") throw error;
  }
  await Promise.all((await listRuntimePeers()).map(async (peer) => {
    try {
      await (await peerRequest(peer.id, "operation", { operation: "get", args: { id }, actor, identity }, 5e3)).json();
      owners.push(peer.id);
    } catch (error) {
      if (error instanceof BrowserRequestError && (error.status === 404 && error.message === "Browser session not found" || error.status === 403 && (/Project is not shared/.test(error.message) || error.message === notSharedWithNode))) return;
      unavailable.push(peer.id);
    }
  }));
  if (owners.length > 1) throw new BrowserRequestError(409, "Browser session ID has multiple physical owners");
  if (owners.length === 1) return owners[0];
  if (unavailable.length) throw new BrowserRequestError(503, `Browser session owner unavailable: ${unavailable.join(", ")}. No other account was selected.`);
  throw new BrowserRequestError(404, "Browser session not found");
}
async function browserDownload(id, downloadId, nodeId, identity) {
  idSchema.parse(id);
  idSchema.parse(downloadId);
  if (idSchema.parse(nodeId) === (await getClusterNode()).id) {
    if (identity) await authorizeBrowserAgent({ operation: "get", args: { id } }, identity);
    const file = await browserRuntime().download(id, downloadId);
    return { stream: createReadStream(file.path), name: file.name };
  }
  const response = await peerRequest(nodeId, "download", { id, downloadId, identity }, 12e4);
  if (!response.body) throw new BrowserRequestError(502, "Browser download has no content");
  return { stream: Readable.fromWeb(response.body), name: decodeURIComponent(response.headers.get("x-browser-filename") || "download") };
}
async function attachBrowserViewer(socket, url, actor, machineNodeId) {
  try {
    const id = idSchema.parse(url.searchParams.get("browserSessionId"));
    if (machineNodeId) {
      const session = await browserRuntime().get(id);
      if (!await relayedSessionAllowed(machineNodeId, session)) throw Error(notSharedWithNode);
      trackRuntimeSocket(socket, machineNodeId, session.projectId);
      await browserRuntime().attachViewer(id, socket, actor, true);
      return;
    }
    const nodeId = idSchema.optional().parse(url.searchParams.get("nodeId") ?? void 0) ?? await browserSessionOwner(id, actor);
    if (nodeId === (await getClusterNode()).id) {
      await browserRuntime().attachViewer(id, socket, actor, false);
      return;
    }
    const peer = await getRuntimePeer(nodeId);
    if (!peer) throw Error("Browser node unavailable");
    const remote = new URL("/ws", peer.url);
    remote.protocol = remote.protocol === "https:" ? "wss:" : "ws:";
    remote.search = new URLSearchParams({ mode: "browser", browserSessionId: id, controllerId: actor.kind === "human" ? actor.id : "agent" }).toString();
    const upstream = new WebSocket(remote, { headers: await runtimeSocketHeaders(peer.id, remote), handshakeTimeout: 1e4, maxPayload: 32 * 1024 * 1024 });
    const queued = [];
    let queuedBytes = 0;
    socket.on("message", (data) => {
      const buffer = Buffer.from(data);
      if (upstream.readyState === WebSocket.OPEN) {
        if (upstream.bufferedAmount > 32 * 1024 * 1024) {
          socket.close(1009);
          return;
        }
        upstream.send(buffer);
      } else if (upstream.readyState === WebSocket.CONNECTING && (queuedBytes += buffer.length) < 1024 * 1024) queued.push(buffer);
      else socket.close(1009);
    });
    upstream.once("open", () => {
      if (socket.readyState !== WebSocket.OPEN) {
        upstream.close();
        return;
      }
      for (const data of queued) upstream.send(data);
      queued.length = 0;
    });
    upstream.on("message", (data) => {
      if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 8 * 1024 * 1024) socket.send(data.toString());
    });
    socket.once("close", () => upstream.terminate());
    upstream.once("close", () => socket.close(1012, "Browser node disconnected; reconnect to resume viewing"));
    upstream.on("error", () => socket.close(1011, "Browser node unavailable"));
    socket.on("error", () => upstream.terminate());
  } catch (error) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "browserError", error: error instanceof Error ? error.message : "Browser unavailable" }));
    socket.close(1008, "Browser session unavailable");
  }
}
export {
  BrowserRequestError,
  acceptBrowserClusterDefault,
  attachBrowserViewer,
  authorizeBrowserAgent,
  browserDefault,
  browserDownload,
  browserOperation,
  browserOperationSchema,
  browserPreferences,
  browserProfileDirectory,
  browserRuntime,
  browserSessionOwner,
  browserShareTargets,
  browserStatus,
  canonicalBrowserIdentity,
  closeBrowserRuntime,
  configureBrowserExecutor,
  configureClusterBrowserDefault,
  configureClusterBrowserOverride,
  discoverBrowserProfiles,
  localBrowserOperation,
  localBrowserStatus,
  manageBrowserProfile,
  profileAccessUpdateSchema,
  profileChangeSchema,
  relayedSessionAllowed,
  requireCompleteDiscovery
};
