import { z } from "zod";
import { isTwinOrigin } from "../account-keys.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { appendBobMessage, bobDatabase } from "../control-center/bob-store.js";
import { resolveProjectAlias } from "../replication.js";
import { getProject } from "../store.js";
import type { HarnessId } from "../types.js";
import { conversationLiveModel, DigestError, requestDigest } from "./conversation-digest-runner.js";
import { findHarnessSession } from "./harness-sessions.js";
import { sendError } from "./http-auth.js";
import { getRuntimePeer, runtimeFetch } from "./runtime-peers.js";
import { app } from "./state.js";

// Bob writes, or brings up to date, the summary of conversations the person names. A summary is written and kept by the machine
// that runs the conversation, where its transcript is and where every board reads it; for a conversation another of the person's
// machines runs, this machine asks that one to write it.

/** Writing a summary is an agent turn: long enough for a long conversation's first one. */
const REMOTE_TIMEOUT_MS = 5 * 60_000;

export interface SummaryTarget { projectId: string; projectName: string; conversationId: string; engine: string; sessionId: string; title: string; nodeId: string | null }

/** The summary, or why there is none. */
type Written = { summary: string } | { problem: string };

const writtenSchema = z.union([z.object({ summary: z.string() }).strict(), z.object({ problem: z.string() }).strict()]);
const askSchema = z.object({ projectId: z.string().min(1).max(240), conversationId: z.string().min(1).max(240), engine: z.string().min(1).max(40), sessionId: z.string().min(1).max(240) }).strict();

/** Writes the summary on this machine, with the agent and model the conversation runs with now, when it is open here. */
async function writeHere(projectId: string, conversationId: string, engine: string, sessionId: string): Promise<Written> {
  const project = await getProject(projectId);
  if (!project) return { problem: "its project is not on the machine that runs it" };
  const shared = findHarnessSession(projectId, engine as HarnessId, sessionId);
  try {
    return { summary: (await requestDigest(project, conversationId, shared ? conversationLiveModel(shared) : undefined)).summary };
  } catch (error) {
    if (error instanceof DigestError && error.status === 409) return { problem: "it has no answer to summarize yet" };
    return { problem: error instanceof Error ? error.message.slice(0, 300) : "the summary could not be written" };
  }
}

async function writeThere(nodeId: string, target: SummaryTarget): Promise<Written> {
  const peer = await getRuntimePeer(nodeId);
  if (!peer) return { problem: "the machine that runs it cannot be reached now" };
  let reply: Response;
  try {
    reply = await runtimeFetch(`${peer.url}/api/cluster/control-center/summarize`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
      body: JSON.stringify({ projectId: target.projectId, conversationId: target.conversationId, engine: target.engine, sessionId: target.sessionId }),
    });
  } catch (error) {
    return { problem: `the machine that runs it did not answer (${error instanceof Error ? error.message : String(error)})` };
  }
  if (reply.status === 404) return { problem: "the machine that runs it is on an older version; update it first" };
  if (!reply.ok) return { problem: `the machine that runs it refused (${reply.status})` };
  return writtenSchema.parse(await reply.json());
}

/** Writes each conversation's summary where it runs, and posts each in the person's chat with Bob as it comes. */
export async function writeSummaries(accountId: string, targets: SummaryTarget[]): Promise<void> {
  await Promise.all(targets.map(async (target) => {
    const written = target.nodeId ? await writeThere(target.nodeId, target) : await writeHere(target.projectId, target.conversationId, target.engine, target.sessionId);
    const about = { projectId: target.projectId, projectName: target.projectName, actions: [{ id: "open", label: "Open", data: { open: { projectId: target.projectId, conversationId: target.conversationId, title: target.title } } }] };
    appendBobMessage(await bobDatabase(), accountId, "summary" in written
      ? { role: "bob", importance: "report", text: `"${target.title}": summary\n\n${written.summary}`, via: "Organize · summary written", ...about }
      : { role: "bob", importance: "fyi", text: `"${target.title}": no summary was written, because ${written.problem}.`, via: "Organize · summary not written", ...about });
  }));
}

/** One of the person's own machines asks this one, which runs the conversation, to write its summary. It names the project by its own id. */
app.post(["/api/cluster/control-center/summarize", "/api/cluster/v2/runtime/control-center/summarize"], async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const db = await clusterV2Database();
    if (!isTwinOrigin(db, response.locals.machineNodeId as string)) { sendError(response, 403, "Only the person's own machines can ask this"); return; }
    const ask = askSchema.parse(request.body);
    response.json(await writeHere(resolveProjectAlias(db, ask.projectId), ask.conversationId, ask.engine, ask.sessionId));
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid request"); return; }
    next(error);
  }
});
