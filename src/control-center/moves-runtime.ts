import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type WebSocket from "ws";
import { z } from "zod";
import type { AuthSession } from "../auth.js";
import { getClusterNode } from "../cluster.js";
import { getConversationOwnership } from "../conversation-ownership.js";
import { getHarness, getHarnessRuntime, listHarnessModels } from "../harnesses.js";
import { sessionListingChanged } from "../session-listing-revisions.js";
import { encodeAuthor } from "../message-authors.js";
import { peerWebSocket } from "../relay/transport.js";
import { peerMayRunHere, publicClusterPeer } from "../server/cluster-helpers.js";
import { projectsWithSharedNames } from "../server/projects.js";
import { takeLocalSessionOwnership } from "../server/routes/sessions.js";
import { getRuntimePeer, listRuntimePeers, runtimeFetch, runtimeSocketHeaders } from "../server/runtime-peers.js";
import { noteUnannouncedRunChanges, sharedProjectSessions } from "../server/sessions-helpers.js";
import { server } from "../server/state.js";
import { getProject } from "../store.js";
import type { HarnessId, ProjectRecord } from "../types.js";
import type { MoveConversation, MoveEnvironment, MoveNode, MoveRef } from "./moves.js";

/** The real `MoveEnvironment`: this node's cluster, the existing ownership transfer and signed node sockets. */

/** Every machine a conversation could move to: this one, and each peer this node knows. */
export async function listMoveNodes(): Promise<MoveNode[]> {
  const local = await getClusterNode();
  const peers = (await listRuntimePeers()).map(publicClusterPeer);
  return [{ id: local.id, name: local.name, local: true, online: true }, ...peers.map((peer) => ({ id: peer.id, name: peer.name, local: false, online: peer.online }))];
}

export interface MoveCheckInput { projectId: string; engine: string; model: string | null }

export const moveCheckSchema = z.object({
  projectId: z.string().min(1).max(200),
  engine: z.string().min(1).max(60),
  model: z.string().max(300).nullable(),
}).strict();

/**
 * What stops a conversation running on THIS machine: the project is not set up here, the machine does not take runs
 * from `callerNodeId`, the harness is not installed, nobody is signed in to it, or it does not offer the model.
 * Answered on the machine that would run it, so the answer is the machine's own.
 */
export async function localMoveBlockers(input: MoveCheckInput, callerNodeId?: string): Promise<string[]> {
  const project = await getProject(input.projectId);
  if (!project) return ["The project is not set up on this machine"];
  try { if (!(await stat(project.path)).isDirectory()) return ["The project folder on this machine is not a folder"]; }
  catch { return ["The project folder is not available on this machine"]; }
  if (callerNodeId && !await peerMayRunHere(callerNodeId)) return ["This machine does not accept runs from other machines"];
  const harnessId = input.engine as HarnessId;
  let label: string;
  try { label = getHarness(harnessId).label; } catch { return [`${input.engine} is not installed on this machine`]; }
  let runtime;
  try { runtime = await getHarnessRuntime(harnessId); } catch { return [`${label} cannot run on this machine`]; }
  const setup = await runtime.readiness(project.path);
  if (setup.length) return [`${label} is not set up on this machine: ${setup.join("; ")}`];
  const login = await runtime.signInProblems();
  if (login.length) return [`${label} is not signed in on this machine: ${login.join("; ")}`];
  if (input.model) {
    const models = await listHarnessModels(harnessId).catch(() => []);
    if (models.length && !models.some((model) => model.id === input.model || model.label === input.model)) return [`The model ${input.model} is not available to ${label} on this machine`];
  }
  return [];
}

async function remoteBlockers(target: MoveNode, input: MoveCheckInput): Promise<string[]> {
  const peer = await getRuntimePeer(target.id);
  if (!peer || !target.online) return [`${target.name} is offline`];
  try {
    const reply = await runtimeFetch(`${peer.url}/api/cluster/sessions/move-check`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.timeout(8_000),
    });
    // A machine on an older version has no check; it is not guessed at.
    if (reply.status === 404) return [`${target.name} runs an older version that cannot say whether it can run this; update it first`];
    if (!reply.ok) {
      const body = await reply.json().catch(() => ({})) as { error?: string };
      return [`${target.name} could not check this conversation (${reply.status}${body.error ? `: ${body.error}` : ""})`];
    }
    return z.object({ reasons: z.array(z.string()) }).parse(await reply.json()).reasons;
  } catch (error) {
    return [`${target.name} did not answer the check: ${error instanceof Error ? error.message : String(error)}`];
  }
}

async function socketUrl(node: MoveNode): Promise<URL> {
  if (node.local) {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("This machine's server is not listening");
    return new URL(`ws://127.0.0.1:${address.port}/ws`);
  }
  const peer = await getRuntimePeer(node.id);
  if (!peer) throw new Error(`${node.name} is not reachable`);
  const url = new URL("/ws", peer.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

const SOCKET_TIMEOUT_MS = 30_000;

/** Opens the conversation on the machine that owns it as a signed node session, as the schedules do, and hands the socket over once it is ready. */
async function withConversationSocket<T>(node: MoveNode, conversation: MoveConversation, session: AuthSession, act: (socket: WebSocket) => Promise<T>): Promise<T> {
  const url = await socketUrl(node);
  const author = { accountId: session.accountId, email: session.email, username: session.username, homeNodeId: session.homeNodeId };
  for (const [key, value] of Object.entries({ projectId: conversation.projectId, sessionId: conversation.sessionId, sessionPath: conversation.path, nodeSession: "1", author: encodeAuthor(author) })) url.searchParams.set(key, value);
  const socket = peerWebSocket(url, { headers: await runtimeSocketHeaders(node.id, url) }, node.id);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${node.name} did not open the conversation in time`)), SOCKET_TIMEOUT_MS);
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
      socket.once("close", (_code, reason) => { clearTimeout(timer); reject(new Error(`${node.name} closed the connection: ${reason.toString() || "no reason given"}`)); });
      socket.on("message", (raw) => {
        const event = JSON.parse(raw.toString()) as { type?: string; readOnly?: boolean; ownership?: unknown };
        if (event.type !== "ready") return;
        clearTimeout(timer);
        if (event.readOnly || event.ownership) reject(new Error(`${node.name} does not own this conversation`));
        else resolve();
      });
    });
    return await act(socket);
  } finally {
    socket.terminate();
  }
}

/** Resolves when the node sends an event that satisfies `matches`, or after `ms`: callers that only want to give the node a moment use it, and check the outcome themselves. */
function eventOrTimeout(socket: WebSocket, matches: (event: { type?: string }) => boolean, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void { clearTimeout(timer); socket.off("message", onMessage); resolve(); }
    function onMessage(raw: WebSocket.RawData): void { if (matches(JSON.parse(raw.toString()) as { type?: string })) done(); }
    socket.on("message", onMessage);
  });
}

const STOP_GRACE_MS = 8_000;

export function createMoveEnvironment(session: AuthSession): MoveEnvironment {
  let projects: Promise<ProjectRecord[]> | undefined;
  const checks = new Map<string, Promise<string[]>>();
  return {
    nodes: listMoveNodes,

    async resolve(ref: MoveRef): Promise<MoveConversation | null> {
      projects ??= projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false });
      const project = (await projects).find((candidate) => candidate.id === ref.projectId);
      if (!project) return null;
      await noteUnannouncedRunChanges();
      const found = (await sharedProjectSessions(project, session.userId, session.accountId)).find((candidate) => (candidate.conversationId ?? candidate.id) === ref.conversationId);
      if (!found) return null;
      const local = await getClusterNode();
      // The owner is read where it is recorded: the list is kept for a while and would still name the old machine just after a move.
      const ownership = await getConversationOwnership(found.harnessId, found.id);
      return {
        projectId: project.id, conversationId: ref.conversationId, projectName: project.name,
        sessionId: found.id, path: found.path, title: found.title,
        harnessId: found.harnessId, harnessLabel: getHarness(found.harnessId).label, model: found.agentModel ?? null,
        ownerNodeId: ownership?.ownerNodeId ?? found.executionNodeId ?? local.id,
        turnRunning: Boolean(found.turnRunning),
        fixedReason: found.readOnly ? "Its transcript is read-only" : found.taskId ? "It belongs to a ticket: move the ticket instead" : null,
      };
    },

    blockers(conversation, target) {
      // The answer depends on the project, harness and model, not on which conversation asks.
      const key = JSON.stringify([target.id, conversation.projectId, conversation.harnessId, conversation.model]);
      const input = { projectId: conversation.projectId, engine: conversation.harnessId, model: conversation.model };
      let answer = checks.get(key);
      if (!answer) { answer = target.local ? localMoveBlockers(input) : remoteBlockers(target, input); checks.set(key, answer); }
      return answer;
    },

    async stopTurn(conversation, owner) {
      const node = owner ?? (await listMoveNodes()).find((candidate) => candidate.local)!;
      await withConversationSocket(node, conversation, session, async (socket) => {
        const answered = eventOrTimeout(socket, (event) => event.type === "status", STOP_GRACE_MS);
        socket.send(JSON.stringify({ type: "abort" }));
        await answered;
      });
    },

    async takeOwnership(conversation, target) {
      const project = await getProject(conversation.projectId);
      if (!project) throw new Error("The project is not set up on this machine");
      const payload = { projectId: project.id, peerId: target.id, sessionId: conversation.sessionId, sessionPath: conversation.path, sessionName: conversation.title.slice(0, 120) };
      // The same routing as "Runs on": the machine that will own the conversation performs the takeover.
      if (target.local) await takeLocalSessionOwnership(project, payload);
      else {
        const peer = await getRuntimePeer(target.id);
        if (!peer) throw new Error(`${target.name} is not reachable`);
        const reply = await runtimeFetch(`${peer.url}/api/cluster/sessions/take-ownership`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(120_000),
        });
        if (!reply.ok) {
          const body = await reply.json().catch(() => ({})) as { error?: string };
          throw new Error(body.error ?? `${target.name} refused the move (${reply.status})`);
        }
      }
      // Pages showing the list or the board read the new owner now, not when the kept list expires.
      sessionListingChanged(project.id);
    },

    async sendMessage(conversation, target, text) {
      const requestId = randomUUID();
      await withConversationSocket(target, conversation, session, (socket) => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("the conversation did not queue it in time")), SOCKET_TIMEOUT_MS);
        socket.on("message", (raw) => {
          const event = JSON.parse(raw.toString()) as { type?: string; queued?: boolean; requestId?: string; error?: string };
          if (event.type === "userMessage" && event.queued && event.requestId === requestId) { clearTimeout(timer); resolve(); }
          if (event.type === "error") { clearTimeout(timer); reject(new Error(event.error ?? "the conversation refused it")); }
        });
        socket.send(JSON.stringify({ type: "prompt", message: text, requestId }));
      }));
    },

    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
