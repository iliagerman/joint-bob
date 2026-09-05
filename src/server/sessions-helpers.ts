import { refreshAgentRun } from "../agent-run-monitor.js";
import { isClaudeSessionRunning } from "../claude-runtime.js";
import { type ClusterPeer, getClusterNode, getClusterPeer, listClusterPeers } from "../cluster.js";
import { compareAndSetConversationOwnership, type ConversationEngine, type ConversationOwnership, ConversationOwnershipError, type ConversationOwnershipStatus, finalizeConversationClaim, getConversationOwnership, type OwnershipApplyResult, sameConversationOwnership } from "../conversation-ownership.js";
import { syncConversationReviewStates } from "../conversation-reviews.js";
import { conversationLeaseRunning } from "../conversation-runtime.js";
import { listHarnessSessions } from "../harnesses.js";
import { getSessionStatus } from "../pi-service.js";
import { getUserPreferences } from "../preferences.js";
import { listTasks } from "../tasks.js";
import type { ProjectRecord, SessionSummary } from "../types.js";
import { listUserPins } from "../user-pins.js";
import { claudeRunKey } from "./chat.js";
import { sessionKey } from "./realtime.js";
import { runningClaudeSessionPaths, sharedSessions } from "./state.js";
import { taskConfig, taskCwd, taskPhase } from "./task-runs.js";

/**
 * Shared by the per-project conversation list and the cross-project review inbox, so both
 * see the same running detection and the same persisted review watermarks. Running is
 * local runtime state or a live lease replicated from the node executing the turn.
 */
export async function listProjectSessionsWithReviewState(project: ProjectRecord, userId: string, username: string): Promise<SessionSummary[]> {
  const tasks = await listTasks(project.id);
  const pinnedSessionPaths = getUserPreferences(userId).pinnedSessionPaths;
  const pinnedSessionIds = listUserPins(username).conversations
    .filter((pin) => pin.projectId === project.id)
    .map((pin) => `${pin.engine}:${pin.sessionId}`);
  const sessions = await listHarnessSessions({
    ...project,
    additionalPaths: tasks.flatMap((task) => task.worktreePath ? [task.worktreePath] : []),
  }, pinnedSessionPaths, pinnedSessionIds);
  const tasksBySessionPath = new Map(tasks.filter((task) => task.sessionPath).map((task) => [task.sessionPath, task]));
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const projectSharedSessions = [...new Set(sharedSessions.values())].filter((shared) => shared.projectId === project.id);
  await Promise.all(projectSharedSessions.map(async (shared) => {
    for (const run of shared.agentRuns.values()) {
      try { run.summary = await refreshAgentRun(run.descriptor); }
      catch (error) { console.warn(`Could not refresh agent run ${run.descriptor.runId}`, error); }
    }
  }));
  const listedSessions = sessions.map((session) => {
    const task = (session.taskId ? tasksById.get(session.taskId) : undefined) ?? tasksBySessionPath.get(session.path);
    const shared = sharedSessions.get(sessionKey(task ? taskCwd(project, task) : project.path, session.path))
      ?? projectSharedSessions.find((candidate) => candidate.handle.session.sessionId === session.id);
    const config = task?.executionState === "running" ? taskConfig(task, taskPhase(task)) : undefined;
    const agentLabel = config ? (config.engine === "pi" ? "Pi" : "Claude") : session.agentLabel;
    const agentId = config ? config.engine : session.harnessId;
    const livePiModel = (!config || config.engine === "pi") && shared
      ? getSessionStatus(shared.handle.session, shared.handle.safeguardsEnabled).model?.label
      : undefined;
    const agentModel = config?.modelId || livePiModel;
    return {
      ...session,
      agentId,
      agentLabel,
      ...(agentModel ? { agentModel } : {}),
      taskStatus: task?.status,
      taskId: task?.id,
      agentRuns: shared ? [...shared.agentRuns.values()].map((run) => run.summary).sort((left, right) => left.runId.localeCompare(right.runId)) : undefined,
      running: Boolean(
        shared?.handle.session.isStreaming
        || (shared?.turnInFlight ?? 0) > 0
        || [...(shared?.agentRuns.values() ?? [])].some((run) => run.summary.status === "running")
        || task?.executionState === "running"
        || runningClaudeSessionPaths.has(claudeRunKey(project.id, session.path))
        || (session.harnessId === "claude" && isClaudeSessionRunning(session.path))
        || conversationLeaseRunning(session.harnessId, session.id)
      ),
      engine: session.harnessId,
      sessionId: session.id,
    };
  });
  const reviewStates = syncConversationReviewStates(userId, username, project.id, listedSessions);
  const ownership = await Promise.all(listedSessions.map((session) => getConversationOwnership(session.path.startsWith("claude:") || session.path.startsWith("draft:claude:") ? "claude" : "pi", session.id)));
  return listedSessions.map((session, index) => {
    const { engine: _engine, sessionId: _sessionId, ...summary } = session;
    return { ...summary, reviewState: reviewStates.get(session.path), executionNodeId: ownership[index]?.ownerNodeId };
  });
}

async function ownershipFromPeer(peer: ClusterPeer, engine: ConversationEngine, sessionId: string): Promise<ConversationOwnership | null> {
  const url = new URL("/api/cluster/sessions/ownership", peer.url);
  url.searchParams.set("engine", engine);
  url.searchParams.set("sessionId", sessionId);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${peer.token}` }, signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`Ownership read failed from ${peer.name}`);
  return (await response.json() as { ownership: ConversationOwnership | null }).ownership;
}

async function claimCasOnPeer(peer: ClusterPeer, expected: ConversationOwnership | null, proposed: ConversationOwnership, originNodeId: string): Promise<OwnershipApplyResult> {
  const response = await fetch(`${peer.url}/api/cluster/sessions/ownership/claim/cas`, {
    method: "POST", headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expected, proposed, originNodeId }), signal: AbortSignal.timeout(3_000),
  });
  const result = await response.json() as OwnershipApplyResult & { error?: string };
  if (!response.ok) throw new Error(result.error || `Ownership compare-and-set failed on ${peer.name}`);
  return result;
}

function assertClaimAccepted(results: OwnershipApplyResult[], proposed: ConversationOwnership): void {
  const rejected = results.find((result) => !result.accepted || !sameConversationOwnership(result.current ?? undefined, proposed));
  if (rejected) throw new Error(`Ownership claim rejected; current state: ${JSON.stringify(rejected.current)}`);
}

async function finalizeClaimOnOwner(ownerNodeId: string, peers: ClusterPeer[], proposed: ConversationOwnership): Promise<ConversationOwnership> {
  const local = await getClusterNode();
  if (ownerNodeId === local.id) return finalizeConversationClaim(proposed, ownerNodeId);
  const peer = peers.find((candidate) => candidate.id === ownerNodeId);
  if (!peer) throw new Error("Ownership claimant left the captured membership");
  const response = await fetch(`${peer.url}/api/cluster/sessions/ownership/claim/commit`, {
    method: "POST", headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ proposed }), signal: AbortSignal.timeout(3_000),
  });
  const result = await response.json() as { ownership?: ConversationOwnership; error?: string };
  if (!response.ok || !result.ownership) throw new Error(result.error || "Ownership claim commit failed");
  return result.ownership;
}

function claimStateMatches(record: ConversationOwnership | null, proposed: ConversationOwnership): boolean {
  if (!record) return true;
  if (sameConversationOwnership(record, proposed)) return true;
  return record.status === "owned" && sameConversationOwnership(record, { ...proposed, status: "owned" });
}

async function commitPreparedClaim(localId: string, peers: ClusterPeer[], proposed: ConversationOwnership): Promise<ConversationOwnership> {
  const owned = { ...proposed, status: "owned" as const };
  const nonOwnerResults: OwnershipApplyResult[] = [];
  if (localId !== proposed.ownerNodeId) nonOwnerResults.push(await compareAndSetConversationOwnership(proposed, owned, proposed.ownerNodeId));
  const remoteResults = await Promise.all(peers.filter((peer) => peer.id !== proposed.ownerNodeId)
    .map((peer) => claimCasOnPeer(peer, proposed, owned, proposed.ownerNodeId)));
  assertClaimAccepted([...nonOwnerResults, ...remoteResults], owned);
  return finalizeClaimOnOwner(proposed.ownerNodeId, peers, proposed);
}

export async function coordinateOwnershipClaim(engine: ConversationEngine, sessionId: string, ownerNodeId: string): Promise<ConversationOwnership> {
  const local = await getClusterNode();
  const peers = await listClusterPeers();
  const memberIds = [local.id, ...peers.map((peer) => peer.id)].sort();
  if (memberIds[0] !== local.id) throw new Error("Ownership claim reached a non-coordinator node");
  if (!memberIds.includes(ownerNodeId)) throw new Error("Ownership claimant is not a captured cluster member");
  const currents = await Promise.all([getConversationOwnership(engine, sessionId).then((value) => value ?? null), ...peers.map((peer) => ownershipFromPeer(peer, engine, sessionId))]);
  const retry = currents.find((record) => record?.status === "claiming" || record?.status === "owned");
  const proposed = retry ? { ...retry, status: "claiming" as const } : { engine, sessionId, ownerNodeId, epoch: 1, status: "claiming" as const, transferToNodeId: null };
  if (proposed.ownerNodeId !== ownerNodeId) throw new ConversationOwnershipError(retry!);
  if (currents.some((record) => !claimStateMatches(record, proposed))) throw new Error("Ownership claim states differ across captured members");
  if (currents.every((record) => record?.status === "owned")) return { ...proposed, status: "owned" };
  const localPrepare = currents[0]?.status === "owned"
    ? Promise.resolve({ accepted: true, current: proposed })
    : compareAndSetConversationOwnership(currents[0] ?? undefined, proposed, local.id);
  const remotePrepare = peers.map((peer, index) => currents[index + 1]?.status === "owned"
    ? Promise.resolve({ accepted: true, current: proposed })
    : claimCasOnPeer(peer, currents[index + 1], proposed, local.id));
  const prepareResults = await Promise.all([localPrepare, ...remotePrepare]);
  assertClaimAccepted(prepareResults, proposed);
  return commitPreparedClaim(local.id, peers, proposed);
}

export async function claimConversationAcrossCluster(engine: ConversationEngine, sessionId: string, localNodeId: string): Promise<ConversationOwnership> {
  const current = await getConversationOwnership(engine, sessionId);
  if (current?.ownerNodeId === localNodeId && current.status === "owned") return current;
  if (current && current.status !== "claiming") throw new ConversationOwnershipError(current);
  const peers = await listClusterPeers();
  const coordinatorId = [localNodeId, ...peers.map((peer) => peer.id)].sort()[0];
  if (coordinatorId === localNodeId) return coordinateOwnershipClaim(engine, sessionId, localNodeId);
  const coordinator = peers.find((peer) => peer.id === coordinatorId)!;
  const response = await fetch(`${coordinator.url}/api/cluster/sessions/ownership/claim`, {
    method: "POST", headers: { Authorization: `Bearer ${coordinator.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ engine, sessionId, ownerNodeId: localNodeId }), signal: AbortSignal.timeout(5_000),
  });
  const result = await response.json() as { ownership?: ConversationOwnership; error?: string };
  if (!response.ok || !result.ownership || result.ownership.status !== "owned") throw new Error(result.error || "Ownership claim failed");
  return result.ownership;
}

async function assertLocalConversationOwner(engine: ConversationEngine, sessionId: string): Promise<void> {
  const local = await getClusterNode();
  const ownership = await getConversationOwnership(engine, sessionId);
  if (!ownership) throw new Error("Conversation ownership is not established");
  if (ownership.ownerNodeId !== local.id || ownership.status !== "owned") throw new ConversationOwnershipError(ownership);
}

export interface ForeignConversationOwner { nodeId: string; nodeName: string; status: ConversationOwnershipStatus }

// The browser locks its composer on this, so a conversation owned elsewhere is
// reported by name instead of letting the user type a prompt that node rejects.
export async function describeConversationOwner(ownership: ConversationOwnership, localId: string): Promise<ForeignConversationOwner | null> {
  if (ownership.ownerNodeId === localId) return null;
  const peer = await getClusterPeer(ownership.ownerNodeId);
  return { nodeId: ownership.ownerNodeId, nodeName: peer?.name ?? "another node", status: ownership.status };
}

async function foreignConversationOwner(engine: ConversationEngine, sessionId: string, localId: string): Promise<ForeignConversationOwner | null> {
  const ownership = await getConversationOwnership(engine, sessionId);
  return ownership ? describeConversationOwner(ownership, localId) : null;
}

// Opening a conversation is what establishes its owner. Claiming only on the
// first prompt left every unprompted conversation ownerless, so a second node
// had nothing to report and its composer stayed open.
export async function openConversationOwnership(engine: ConversationEngine, sessionId: string, localId: string): Promise<ForeignConversationOwner | null> {
  const foreign = await foreignConversationOwner(engine, sessionId, localId);
  if (foreign) return foreign;
  if (await getConversationOwnership(engine, sessionId)) return null;
  try {
    await claimConversationAcrossCluster(engine, sessionId, localId);
    return null;
  } catch (error) {
    if (!(error instanceof ConversationOwnershipError)) throw error;
    return describeConversationOwner(error.ownership, localId);
  }
}

export async function requireLocalConversationOwner(engine: ConversationEngine, sessionId: string): Promise<void> {
  const local = await getClusterNode();
  if (!await getConversationOwnership(engine, sessionId)) await claimConversationAcrossCluster(engine, sessionId, local.id);
  await assertLocalConversationOwner(engine, sessionId);
}
