import { randomUUID } from "node:crypto";
import { authSessionEvents, sessionCookieNameFor, sessionForId } from "../auth.js";
import { getClusterNode } from "../cluster.js";
import { getRuntimePeer, runtimeSocketHeaders, signedSocketPeer, trackRuntimeSocket } from "./runtime-peers.js";
import { clusterPeerMayAccessProject, peerMayOpenTerminal } from "./cluster-helpers.js";
import { getConversationOwnership } from "../conversation-ownership.js";
import { ensureConversationRecord, getConversationRecord, listConversationSegments, parseConversationDraftPath } from "../conversation-records.js";
import { findHarnessSession, harnessForSessionPath, listHarnesses, listHarnessSessions } from "../harnesses.js";
import { getProjectLock } from "../project-locks.js";
import { ensureWorktreeLocalFiles, getProjectWorktree, markWorktreeConversation, worktreeConversationIndex } from "../project-worktrees.js";
import { resolveLocalSessionPath } from "../session-paths.js";
import { getProject } from "../store.js";
import { getSettings } from "../settings.js";
import { listTasks } from "../tasks.js";
import { attachTerminalSession } from "../terminal-session.js";
import { webSocketCloseReason } from "../websocket.js";
import { proxySocket, sessionWatcher } from "./chat.js";
import { attachHarnessChat } from "./harness-chat.js";
import { conversationBelongsToDoneTask, taskConversationIdentity } from "./cluster-helpers.js";
import { attachBrowserViewer } from "./browser.js";
import { broadcastToProject, send } from "./realtime.js";
import { socketSecretAccountIdsSchema, socketTaskIdSchema } from "./schemas.js";
import { openConversationOwnership } from "./sessions-helpers.js";
import { watchClients, webSocketServer } from "./state.js";
import { ownerPeer } from "./task-handoff.js";
import { measureOperation, traceOperation } from "./performance-diagnostics.js";
import { projectAdditionalPaths } from "./session-scope.js";
import { mergeReservations, taskCwd, taskHandoffContext, taskTerminalCounts } from "./task-runs.js";
import { relayPeerOf, relayTransportOf } from "../relay/stream.js";
import { peerWebSocket } from "../relay/transport.js";
import { onPhonePolicyChanged, otherUsersMayUsePhone } from "../relay/phone-policy.js";
async function provisionWorktree(projectPath, worktreePath) {
  await ensureWorktreeLocalFiles(projectPath, worktreePath).catch((error) => console.warn("Worktree local files could not be provisioned", error));
}
function describeSessionRequest(rawSessionPath) {
  const selected = rawSessionPath ?? listHarnesses()[0].paths.newSession;
  const draft = parseConversationDraftPath(selected);
  const adapter = draft ? listHarnesses().find(({ id }) => id === draft.engine) : harnessForSessionPath(selected);
  if (!adapter) throw new Error(`No harness registered for conversation engine: ${draft.engine}`);
  return { draft, engine: adapter.id, sessionPath: draft || selected === adapter.paths.newSession ? void 0 : selected };
}
function isNewSessionPath(value) {
  return Boolean(value && listHarnesses().some((adapter) => adapter.paths.newSession === value));
}
async function directSessionForOpen(project, sessionPath, sessionId) {
  const request = describeSessionRequest(sessionPath);
  if (!request.sessionPath || request.draft) return void 0;
  const record = await getConversationRecord(project.id, request.engine, sessionId);
  if (record && (await listConversationSegments(project.id, record.conversationId ?? sessionId)).length > 1) return void 0;
  return findHarnessSession(project, request.engine, sessionPath, sessionId);
}
const authenticatedSockets = /* @__PURE__ */ new Map();
authSessionEvents.on("revoked", (sessionIds) => {
  const revoked = new Set(sessionIds);
  for (const [socket, entry] of authenticatedSockets) {
    if (revoked.has(entry.sessionId)) socket.close(1008, "Login session revoked");
  }
});
onPhonePolicyChanged((allowed) => {
  if (allowed) return;
  for (const [socket, entry] of authenticatedSockets) {
    if (entry.otherUserPhone) socket.close(1008, "Phone sign-in for other users is off");
  }
});
webSocketServer.on("connection", (socket, request) => {
  traceOperation("chat.connect", () => handleConnection(socket, request)).catch((error) => {
    console.error("WebSocket connection failed", error);
    socket.close(1011, "Connection failed");
  });
});
async function handleConnection(socket, request) {
  const host = request.headers.host;
  const authorization = typeof request.headers.authorization === "string" ? request.headers.authorization : "";
  const url = new URL(request.url ?? "/", `http://${host || "localhost"}`);
  const browserMode = url.searchParams.get("mode");
  let signedPeer;
  if (authorization) {
    try {
      signedPeer = await signedSocketPeer(url.pathname + url.search, authorization);
    } catch {
      socket.close(1008, "Unauthorized");
      return;
    }
    const transport = relayTransportOf(request.socket), channelPeer = relayPeerOf(request.socket);
    if (transport === "gateway" || channelPeer && channelPeer.nodeId !== signedPeer) {
      socket.close(1008, "Unauthorized");
      return;
    }
  } else if (relayTransportOf(request.socket) === "peer") {
    socket.close(1008, "Unauthorized");
    return;
  }
  const browserMachineId = signedPeer;
  const machineAuthenticated = Boolean(signedPeer);
  const origin = request.headers.origin;
  const cookiePrefix = `${sessionCookieNameFor(relayTransportOf(request.socket) === "gateway")}=`;
  const session = sessionForId(request.headers.cookie?.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith(cookiePrefix))?.slice(cookiePrefix.length));
  let browserAuthenticated = false;
  try {
    browserAuthenticated = Boolean(host && typeof origin === "string" && new URL(origin).host === host && session && !session.mustChangePassword && !(session.isRemoteLogin && relayTransportOf(request.socket) === "gateway" && !otherUsersMayUsePhone()));
  } catch {
    browserAuthenticated = false;
  }
  if (!machineAuthenticated && !browserAuthenticated) {
    socket.close(1008, "Unauthorized");
    return;
  }
  if (!machineAuthenticated && session) {
    authenticatedSockets.set(socket, { sessionId: session.id, otherUserPhone: session.isRemoteLogin && relayTransportOf(request.socket) === "gateway" });
    socket.once("close", () => authenticatedSockets.delete(socket));
  }
  if (browserMode && !["browser", "terminal"].includes(browserMode)) {
    socket.close(1008, "Unsupported socket mode");
    return;
  }
  if (browserMode === "browser") {
    const controllerId = browserMachineId ? url.searchParams.get("controllerId") : session?.userId;
    if (!controllerId || controllerId.length > 500) {
      socket.close(1008, "Browser controller identity required");
      return;
    }
    await attachBrowserViewer(socket, url, { kind: "human", id: browserMachineId ? controllerId : `${(await getClusterNode()).id}:${controllerId}` }, browserMachineId);
    return;
  }
  const projectId = url.searchParams.get("projectId") ?? "";
  const project = await getProject(projectId);
  if (!project) {
    socket.close(1008, "Project not found");
    return;
  }
  if (signedPeer) {
    if (signedPeer !== (await getClusterNode()).id && !await clusterPeerMayAccessProject(signedPeer, project.id)) {
      socket.close(1008, "Project is not shared with this node");
      return;
    }
    trackRuntimeSocket(socket, signedPeer, project.id);
  }
  const taskIdResult = socketTaskIdSchema.safeParse(url.searchParams.get("taskId"));
  if (url.searchParams.has("taskId") && !taskIdResult.success) {
    socket.close(1008, "Invalid task ID");
    return;
  }
  const taskId = taskIdResult.success ? taskIdResult.data : void 0;
  const rawSessionPathFromUrl = url.searchParams.get("sessionPath");
  const suppliedSessionId = url.searchParams.get("sessionId");
  const sourceTaskIdResult = socketTaskIdSchema.safeParse(url.searchParams.get("sourceTaskId"));
  if (url.searchParams.has("sourceTaskId") && !sourceTaskIdResult.success) {
    socket.close(1008, "Invalid source task ID");
    return;
  }
  const sourceTaskId = sourceTaskIdResult.success ? sourceTaskIdResult.data : void 0;
  const canMatchTaskSession = rawSessionPathFromUrl && rawSessionPathFromUrl !== "watch" && !isNewSessionPath(rawSessionPathFromUrl);
  const tasks = taskId || sourceTaskId || canMatchTaskSession ? await listTasks(project.id) : [];
  const task = taskId ? tasks.find((candidate) => candidate.id === taskId) : tasks.find((candidate) => candidate.sessionPath === rawSessionPathFromUrl);
  const taskIdentity = task && rawSessionPathFromUrl !== "watch" ? taskConversationIdentity(task) : null;
  const requestedSessionId = suppliedSessionId ?? taskIdentity?.sessionId ?? null;
  const sourceTask = sourceTaskId ? tasks.find((candidate) => candidate.id === sourceTaskId) : void 0;
  const worktreeIdParam = url.searchParams.get("worktreeId");
  if (worktreeIdParam !== null && (taskId || sourceTaskId || !/^[0-9a-f-]{36}$/i.test(worktreeIdParam))) {
    socket.close(1008, "Invalid worktree ID");
    return;
  }
  if (sourceTaskId && (!sourceTask || sourceTask.status !== "done")) {
    socket.close(1008, "Source ticket is not Done");
    return;
  }
  if (sourceTaskId && !isNewSessionPath(rawSessionPathFromUrl)) {
    socket.close(1008, "A follow-up must start a new conversation");
    return;
  }
  if (taskId && !task) {
    socket.close(1008, "Task not found");
    return;
  }
  const local = await getClusterNode();
  if (task?.executionState === "handoff_pending") {
    socket.close(1008, "Task handoff is awaiting destination commit");
    return;
  }
  if (task && task.currentNodeId !== local.id) {
    const peer = await ownerPeer(task, local.id);
    if (!peer) {
      socket.close(1011, "Task owner is unavailable");
      return;
    }
    const ownerUrl = new URL("/ws", peer.url);
    ownerUrl.protocol = ownerUrl.protocol === "https:" ? "wss:" : "ws:";
    ownerUrl.searchParams.set("projectId", project.id);
    ownerUrl.searchParams.set("sessionPath", rawSessionPathFromUrl ?? "new");
    ownerUrl.searchParams.set("taskId", task.id);
    if (requestedSessionId) ownerUrl.searchParams.set("sessionId", requestedSessionId);
    if (url.searchParams.get("mode") === "terminal") ownerUrl.searchParams.set("mode", "terminal");
    proxySocket(socket, peerWebSocket(ownerUrl, { headers: await runtimeSocketHeaders(peer.id, ownerUrl) }, peer.id));
    return;
  }
  const requestedNodeId = url.searchParams.get("nodeId");
  let routingEngine;
  try {
    routingEngine = rawSessionPathFromUrl === "watch" ? listHarnesses()[0].id : describeSessionRequest(rawSessionPathFromUrl).engine;
  } catch (error) {
    socket.close(1008, webSocketCloseReason(error instanceof Error ? error.message : "Invalid conversation path"));
    return;
  }
  if (browserAuthenticated && !task) {
    const ownership = requestedSessionId ? await getConversationOwnership(routingEngine, requestedSessionId) : void 0;
    const targetNodeId = requestedNodeId || ownership?.ownerNodeId;
    if (targetNodeId && targetNodeId !== local.id) {
      const peer = await getRuntimePeer(targetNodeId);
      if (!peer) {
        socket.close(1011, "Execution node is unavailable");
        return;
      }
      const ownerUrl = new URL("/ws", peer.url);
      ownerUrl.protocol = ownerUrl.protocol === "https:" ? "wss:" : "ws:";
      for (const [key, value] of url.searchParams) ownerUrl.searchParams.set(key, value);
      if (!requestedSessionId && isNewSessionPath(rawSessionPathFromUrl)) {
        const sessionId = randomUUID();
        await ensureConversationRecord(project.id, routingEngine, sessionId, local.id);
        ownerUrl.searchParams.set("sessionId", sessionId);
      }
      ownerUrl.searchParams.delete("nodeId");
      ownerUrl.searchParams.set("nodeSession", "1");
      proxySocket(socket, peerWebSocket(ownerUrl, { headers: await runtimeSocketHeaders(peer.id, ownerUrl) }, peer.id));
      return;
    }
  }
  if (machineAuthenticated) {
    const routedSession = url.searchParams.get("nodeSession") === "1";
    if (!task && !routedSession) {
      socket.close(1008, "Unauthorized");
      return;
    }
  }
  const heldLock = browserAuthenticated ? await getProjectLock(project.id) : void 0;
  const lockedByPeer = heldLock && heldLock.nodeId !== local.id ? heldLock : void 0;
  if (url.searchParams.get("mode") === "terminal") {
    if (session?.isRemoteLogin) {
      const reason = "Terminal access is not available for replicated users";
      socket.send(JSON.stringify({ type: "terminalError", error: reason }));
      socket.close(4031, reason);
      return;
    }
    if (signedPeer && !await peerMayOpenTerminal(signedPeer)) {
      const reason = `Terminal access from other nodes is disabled on ${local.name}`;
      socket.send(JSON.stringify({ type: "terminalError", error: reason }));
      socket.close(4031, reason);
      return;
    }
    if (lockedByPeer) {
      socket.close(1008, `Project is locked by ${lockedByPeer.nodeName}`);
      return;
    }
    if (task) {
      const mergeBusy = task.mergeState === "conflicts" || task.mergeState === "resolved" || mergeReservations.has(task.id);
      if (mergeBusy) {
        socket.close(4030, "Ticket merge in progress");
        return;
      }
      const count = (taskTerminalCounts.get(task.id) ?? 0) + 1;
      taskTerminalCounts.set(task.id, count);
      socket.once("close", () => {
        const remaining = (taskTerminalCounts.get(task.id) ?? 1) - 1;
        if (remaining <= 0) taskTerminalCounts.delete(task.id);
        else taskTerminalCounts.set(task.id, remaining);
      });
    }
    const terminalWorktree = !task && worktreeIdParam ? await getProjectWorktree(project.id, worktreeIdParam) : void 0;
    if (worktreeIdParam && !task && !terminalWorktree) {
      socket.close(1008, "Worktree is not synchronized on this node");
      return;
    }
    if (terminalWorktree) await provisionWorktree(project.path, terminalWorktree.path);
    attachTerminalSession(socket, task ? taskCwd(project, task) : terminalWorktree?.path ?? project.path, local.id);
    return;
  }
  let rawSessionPath = rawSessionPathFromUrl;
  const sessionSearchProject = { ...project, additionalPaths: await projectAdditionalPaths(project.id, taskId || sourceTaskId || canMatchTaskSession ? tasks : void 0) };
  let listedSessions;
  const secretAccountIds = socketSecretAccountIdsSchema.parse((url.searchParams.get("secretAccountIds") ?? "").split(",").filter(Boolean));
  if (requestedSessionId && rawSessionPath && rawSessionPath !== "watch" && (!isNewSessionPath(rawSessionPath) || await getConversationRecord(project.id, routingEngine, requestedSessionId))) {
    const direct = await measureOperation("chat.open.direct_lookup", () => directSessionForOpen(sessionSearchProject, rawSessionPath, requestedSessionId));
    listedSessions = direct ? [direct] : await measureOperation("chat.open.catalog", () => listHarnessSessions(sessionSearchProject));
    const listedIdentity = listedSessions.some((candidate) => candidate.id === requestedSessionId || candidate.conversationId === requestedSessionId || candidate.segments?.some((segment) => segment.sessionId === requestedSessionId));
    if (!listedIdentity) {
      const recovered = await measureOperation("chat.open.recover", () => findHarnessSession(sessionSearchProject, routingEngine, rawSessionPath, requestedSessionId));
      if (recovered) listedSessions = [recovered];
    }
    if (task?.sessionPath && taskIdentity?.sessionId === requestedSessionId) rawSessionPath = resolveLocalSessionPath(task.sessionPath).path;
    else {
      const matching = listedSessions.find((candidate) => candidate.id === requestedSessionId);
      if (matching) rawSessionPath = matching.path;
    }
  }
  if (rawSessionPath === "watch") {
    sessionWatcher.ensureProject(project);
    const clients = watchClients.get(project.id) ?? /* @__PURE__ */ new Set();
    clients.add(socket);
    watchClients.set(project.id, clients);
    send(socket, { type: "watchReady" });
    socket.on("message", (raw) => {
      const payload = JSON.parse(raw.toString());
      if (payload.type === "ping") send(socket, { type: "pong" });
    });
    socket.on("close", () => clients.delete(socket));
    return;
  }
  if (lockedByPeer) {
    socket.close(1008, `Project is locked by ${lockedByPeer.nodeName}`);
    return;
  }
  let sessionRequest;
  try {
    sessionRequest = describeSessionRequest(rawSessionPath);
  } catch (error) {
    socket.close(1008, webSocketCloseReason(error instanceof Error ? error.message : "Invalid conversation path"));
    return;
  }
  let requestedTask = sessionRequest.sessionPath ? tasks.find((candidate) => candidate.sessionPath === sessionRequest.sessionPath) : void 0;
  let cwd = requestedTask ? taskCwd(project, requestedTask) : project.path;
  if ((sessionRequest.sessionPath || sessionRequest.draft) && !listedSessions) listedSessions = await measureOperation("chat.open.catalog", () => listHarnessSessions(sessionSearchProject));
  let listedSession = listedSessions?.find((candidate) => candidate.path === (sessionRequest.draft ? rawSessionPath : sessionRequest.sessionPath) || Boolean(!sessionRequest.draft && taskIdentity && requestedSessionId === taskIdentity.sessionId && candidate.harnessId === taskIdentity.engine && candidate.id === taskIdentity.sessionId) || Boolean(sessionRequest.sessionPath && candidate.segments?.some((segment) => segment.path === sessionRequest.sessionPath)));
  if ((sessionRequest.sessionPath || sessionRequest.draft) && !listedSession) {
    socket.close(1008, "Conversation not found");
    return;
  }
  const openedStaleSegment = Boolean(sessionRequest.sessionPath && listedSession?.segments?.some((segment) => segment.path === sessionRequest.sessionPath && segment.path !== listedSession.path));
  if (openedStaleSegment && listedSession) {
    rawSessionPath = listedSession.path;
    sessionRequest = describeSessionRequest(rawSessionPath);
    const redirectedTask = sessionRequest.sessionPath ? tasks.find((candidate) => candidate.sessionPath === sessionRequest.sessionPath) : void 0;
    if (redirectedTask) {
      requestedTask = redirectedTask;
      cwd = taskCwd(project, redirectedTask);
    }
  }
  if (sessionRequest.draft && (!listedSession?.draft || listedSession.id !== sessionRequest.draft.sessionId || !await getConversationRecord(project.id, sessionRequest.draft.engine, sessionRequest.draft.sessionId))) {
    socket.close(1008, "Conversation not found");
    return;
  }
  let spinOffContext = null;
  if (sourceTask) {
    if (!sourceTask.sessionPath) {
      socket.close(1008, "Source ticket has no conversation");
      return;
    }
    try {
      const localSessionPath = resolveLocalSessionPath(sourceTask.sessionPath).path;
      spinOffContext = sourceTask.handoffContext ?? await taskHandoffContext(project, { ...sourceTask, sessionPath: localSessionPath });
    } catch (error) {
      socket.close(1008, webSocketCloseReason(error instanceof Error ? error.message : "Source conversation is unavailable"));
      return;
    }
  }
  const validRequestedSessionId = requestedSessionId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedSessionId) ? requestedSessionId : void 0;
  const ownershipSessionId = listedSession && !listedSession.draft ? listedSession.id : sessionRequest.draft?.sessionId ?? validRequestedSessionId ?? randomUUID();
  const sessionReadOnly = listedSession?.readOnly === true;
  let foreignOwner = null;
  if (!sessionReadOnly) {
    try {
      foreignOwner = await measureOperation("chat.open.ownership", () => openConversationOwnership(sessionRequest.engine, ownershipSessionId, local.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Conversation ownership claim failed";
      if (!listedSession) {
        socket.close(1008, webSocketCloseReason(message));
        return;
      }
      console.warn("Conversation ownership claim failed on open", error);
    }
  }
  const refreshSessionsAfterReady = !listedSession || listedSession.draft;
  let worktree;
  if (!requestedTask && !task) {
    const known = (await worktreeConversationIndex(project.id).catch((error) => {
      console.warn("Worktree conversation index unavailable", error);
      return /* @__PURE__ */ new Map();
    })).get(`${sessionRequest.engine}:${ownershipSessionId}`);
    const requested = refreshSessionsAfterReady && worktreeIdParam ? await getProjectWorktree(project.id, worktreeIdParam) : void 0;
    if (refreshSessionsAfterReady && worktreeIdParam && !requested && !known) {
      socket.close(1008, "Worktree is not synchronized on this node");
      return;
    }
    worktree = known ?? requested;
    if (worktree) {
      cwd = worktree.path;
      await provisionWorktree(project.path, worktree.path);
      if (!known) await markWorktreeConversation(project.id, worktree.id, sessionRequest.engine, ownershipSessionId);
    }
  }
  if (refreshSessionsAfterReady) {
    try {
      await ensureConversationRecord(project.id, sessionRequest.engine, ownershipSessionId, local.id);
    } catch (error) {
      if (error instanceof Error && error.message === "Conversation record was deleted") {
        socket.close(1008, webSocketCloseReason("Conversation not found"));
        return;
      }
      throw error;
    }
  }
  const conversationReadOnly = sessionReadOnly || task?.status === "done" || await conversationBelongsToDoneTask(project.id, sessionRequest.engine, ownershipSessionId);
  try {
    const startCommand = getSettings().conversationCommands.start;
    await attachHarnessChat({
      socket,
      project,
      taskId: task?.id ?? null,
      cwd,
      engine: sessionRequest.engine,
      sessionId: ownershipSessionId,
      sessionPath: sessionRequest.sessionPath,
      accountIds: secretAccountIds,
      readOnly: conversationReadOnly,
      ownership: foreignOwner,
      listedSessions,
      handoffContext: spinOffContext,
      autoStartPrompt: refreshSessionsAfterReady && !sessionRequest.draft && !worktree && startCommand.enabled ? startCommand.prompt : null
    });
    if (refreshSessionsAfterReady) broadcastToProject(project.id, { type: "sessionsChanged" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not start conversation";
    send(socket, { type: "error", error: message });
    socket.close(1011, webSocketCloseReason(message));
  }
}
