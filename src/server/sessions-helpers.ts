import { applyConversationWork, listConversationWork, refreshConversationWork } from "../conversation-work.js";
import { isClaudeSessionRunning } from "../claude-runtime.js";
import { getClusterNode, getClusterPeer } from "../cluster.js";
import { claimConversationOwnership, type ConversationEngine, type ConversationOwnership, ConversationOwnershipError, type ConversationOwnershipStatus, getConversationOwnership, healStaleLocalClaim } from "../conversation-ownership.js";
import { syncConversationReviewStates } from "../conversation-reviews.js";
import { conversationLeaseRunning } from "../conversation-runtime.js";
import { listHarnessSessions } from "../harnesses.js";
import { getSessionStatus } from "../pi-service.js";
import { listRunningPiSessions } from "../pi-runtime.js";
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
  const pinnedSessionPaths = userId ? getUserPreferences(userId).pinnedSessionPaths : [];
  const pinnedSessionIds = (username ? listUserPins(username).conversations : [])
    .filter((pin) => pin.projectId === project.id)
    .map((pin) => `${pin.engine}:${pin.sessionId}`);
  const sessions = await listHarnessSessions({
    ...project,
    additionalPaths: tasks.flatMap((task) => task.worktreePath ? [task.worktreePath] : []),
  }, pinnedSessionPaths, pinnedSessionIds);
  const tasksBySessionPath = new Map(tasks.filter((task) => task.sessionPath).map((task) => [task.sessionPath, task]));
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const projectSharedSessions = [...new Set(sharedSessions.values())].filter((shared) => shared.projectId === project.id);
  await refreshConversationWork();
  for (const shared of projectSharedSessions) {
    for (const work of listConversationWork("pi", shared.handle.session.sessionId)) {
      const run = shared.agentRuns.get(work.summary.runId);
      if (run) run.summary = work.summary;
    }
  }
  const runningPiSessions = new Set(listRunningPiSessions().map((session) => session.sessionId));
  const listedSessions = applyConversationWork(sessions.map((session) => {
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
        || (session.harnessId === "pi" && runningPiSessions.has(session.id))
        || conversationLeaseRunning(session.harnessId, session.id)
      ),
      engine: session.harnessId,
      sessionId: session.id,
    };
  }));
  // Internal snapshots do not belong to a viewer and must not create review records.
  const reviewStates = userId ? syncConversationReviewStates(userId, username, project.id, listedSessions.filter((session) => !session.readOnly)) : new Map();
  const ownership = await Promise.all(listedSessions.map((session) => getConversationOwnership(session.path.startsWith("claude:") || session.path.startsWith("draft:claude:") ? "claude" : "pi", session.id)));
  return listedSessions.map((session, index) => {
    const { engine: _engine, sessionId: _sessionId, ...summary } = session;
    return { ...summary, reviewState: reviewStates.get(session.path), executionNodeId: ownership[index]?.ownerNodeId };
  });
}

// A leftover `claiming` record is a crashed two-phase claim from this node; no
// protocol can still be holding it, so healing it is safe. A foreign
// `claiming` record may belong to a live old-version protocol, so it stays
// locked behind an explicit takeover instead of being stolen.
export async function claimConversationLocally(engine: ConversationEngine, sessionId: string, localNodeId: string): Promise<ConversationOwnership> {
  const current = await getConversationOwnership(engine, sessionId);
  if (!current) return claimConversationOwnership(engine, sessionId, localNodeId);
  if (current.ownerNodeId === localNodeId && current.status === "owned") return current;
  if (current.status === "claiming" && current.ownerNodeId === localNodeId) return healStaleLocalClaim(engine, sessionId, current);
  throw new ConversationOwnershipError(current);
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
// A conflicted conversation is fenced on both sides, including the node the
// conflict record names as owner, so each side is told about the other node.
export async function describeConversationOwner(ownership: ConversationOwnership, localId: string): Promise<ForeignConversationOwner | null> {
  if (ownership.ownerNodeId === localId && ownership.status !== "conflict") return null;
  const otherNodeId = ownership.status === "conflict" && ownership.ownerNodeId === localId
    ? ownership.transferToNodeId ?? ownership.ownerNodeId
    : ownership.ownerNodeId;
  const peer = await getClusterPeer(otherNodeId);
  return { nodeId: otherNodeId, nodeName: peer?.name ?? "another node", status: ownership.status };
}

// Opening a conversation is what establishes its owner. Claiming only on the
// first prompt left every unprompted conversation ownerless, so a second node
// had nothing to report and its composer stayed open.
export async function openConversationOwnership(engine: ConversationEngine, sessionId: string, localId: string): Promise<ForeignConversationOwner | null> {
  const current = await getConversationOwnership(engine, sessionId);
  // A stale two-phase claim by this node is healed by claiming again; every
  // other existing record already names an owner and needs no claim.
  if (current && !(current.status === "claiming" && current.ownerNodeId === localId)) {
    return describeConversationOwner(current, localId);
  }
  try {
    await claimConversationLocally(engine, sessionId, localId);
    return null;
  } catch (error) {
    if (!(error instanceof ConversationOwnershipError)) throw error;
    return describeConversationOwner(error.ownership, localId);
  }
}

export async function requireLocalConversationOwner(engine: ConversationEngine, sessionId: string): Promise<void> {
  const local = await getClusterNode();
  if (!await getConversationOwnership(engine, sessionId)) await claimConversationLocally(engine, sessionId, local.id);
  await assertLocalConversationOwner(engine, sessionId);
}
