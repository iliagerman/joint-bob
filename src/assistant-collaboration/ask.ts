import { randomUUID } from "node:crypto";
import type { Response as ExpressResponse } from "express";
import { z } from "zod";
import { assistantIdForConversation } from "../assistant-resources.js";
import { getClusterNode } from "../cluster.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { listConversationSegments } from "../conversation-records.js";
import type { McpAgentIdentity } from "../mcp/agent.js";
import { accountOfSomeoneElse, adminAccountId } from "../ownership.js";
import { getPersonalAssistant, getPersonalAssistantById, runningPersonalAssistantTurn, type PersonalAssistant } from "../personal-assistants.js";
import { sendError } from "../server/http-auth.js";
import { settled, warnOnChange } from "../server/quiet-log.js";
import type { runPersonalAssistantAutomationTurn } from "../server/routes/personal-assistants.js";
import { projectPrivateToOwner } from "../store.js";
import { runningPromptRequestId } from "./bridge-tools.js";
import { askableHelpers, ownerAssistants, sharedAskerReason, sharedHelperReason } from "./directory.js";
import { finishAsk, getAsk, insertAsk, runningAsksOn, type AskRecord } from "./store.js";
import { postToTwin } from "./twin-sync.js";

/** Why the agent may not do what it asked. The agent reads it as the tool's error. */
export class AskRefusal extends Error {}

type TurnRunner = typeof runPersonalAssistantAutomationTurn;
// The routes module loads with the first ask, not with this module.
const agentTurn: TurnRunner = async (...args) => (await import("../server/routes/personal-assistants.js")).runPersonalAssistantAutomationTurn(...args);
let runTurn = agentTurn;
/** Tests answer helper turns without an agent. Nothing else calls this. */
export function setAskTurnRunner(runner: TurnRunner | undefined): void { runTurn = runner ?? agentTurn; }

/** The assistant whose topic this logical conversation is. Topics are kept per session, so every segment counts. */
export async function assistantForConversation(projectId: string, conversationId: string): Promise<{ assistant: PersonalAssistant; topicIds: string[] } | null> {
  const segments = await listConversationSegments(projectId, conversationId);
  const assistantId = segments.map(segment => assistantIdForConversation(projectId, segment.sessionId)).find(id => id !== null);
  const assistant = assistantId ? await getPersonalAssistantById(assistantId) : undefined;
  return assistant ? { assistant, topicIds: segments.map(segment => `${segment.engine}:${segment.sessionId}`) } : null;
}

/** The asking assistant and its turn, when the prompt running now is that turn and the owner wrote it: chat or a scheduled task. */
export async function askingTurn(identity: McpAgentIdentity): Promise<{ assistant: PersonalAssistant; requestId: string }> {
  const found = await assistantForConversation(identity.projectId, identity.conversationId);
  const turn = found?.assistant.accountId === identity.account.accountId ? await runningPersonalAssistantTurn(found.assistant.id, found.topicIds) : null;
  // A webhook prompt or a stale running row never borrows a chat turn: the turn must be the prompt running now.
  const current = turn && turn.requestId === runningPromptRequestId(identity.projectId, identity.conversationId) ? turn : null;
  // One hop: a turn started by an ask never asks again.
  if (current?.origin === "assistant") throw new AskRefusal("An assistant answering another assistant can't ask a third one.");
  if (!found || !current || (current.origin !== "chat" && current.origin !== "scheduled")) throw new AskRefusal("Only your own chat and scheduled tasks can ask your other assistants.");
  // Answers land in this chat, so it must stay private to the owner, at every call.
  if (!await projectPrivateToOwner(found.assistant.projectId)) throw new AskRefusal(sharedAskerReason(found.assistant));
  return { assistant: found.assistant, requestId: current.requestId };
}

const waiters = new Map<string, Set<() => void>>();
// Asks whose helper turn this process runs. Any other running ask of this machine lost its turn to a restart.
const live = new Set<string>();
// While a running ask's helper machine is being polled: when its status reads started failing, until one succeeds.
const failingSince = new Map<string, number>();
async function settle(id: string, result: { answer: string } | { error: string }): Promise<void> {
  await finishAsk(id, result);
  live.delete(id); failingSince.delete(id);
  for (const wake of waiters.get(id) ?? []) wake();
}

/** Starts the helper's turn on this machine without waiting for it. Its end settles the ask. */
function runHelperTurn(id: string, accountId: string, helperId: string, message: string): void {
  live.add(id);
  void runTurn(accountId, helperId, id, message, { label: "Assistant", origin: "assistant" })
    .then(turn => turn.status === "completed" ? { answer: turn.response ?? "" } : { error: turn.response ?? "The assistant's turn failed." },
      (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }))
    .then(result => settle(id, result))
    .catch(error => console.warn(`Could not record how ask ${id} ended`, error));
}

const ASK_TARGET = "/api/cluster/v2/assistants/ask", STATUS_TARGET = "/api/cluster/v2/assistants/ask-status";
const acknowledgement = z.object({ askId: z.string() }), refusalReply = z.object({ error: z.string().min(1).max(500) });
async function unreachable(record: AskRecord): Promise<string> {
  const machine = (await ownerAssistants(record.accountId)).find(summary => summary.id === record.helperId)?.machineName ?? "its machine";
  return `Couldn't reach ${record.helperName} on ${machine}.`;
}

/** Starts the ask on the helper's machine. It is sent once: a start that fails ends the ask. */
async function sendAsk(record: AskRecord): Promise<void> {
  const payload = { askId: record.id, accountId: record.accountId, askerId: record.askerId, askerName: record.askerName, helperId: record.helperId, message: record.question, purpose: record.purpose };
  try {
    const response = await postToTwin(record.helperNodeId, ASK_TARGET, payload, 15_000);
    // The helper's machine checked again and says why it won't.
    if (response.status === 409) { await settle(record.id, { error: refusalReply.parse(await response.json()).error }); return; }
    if (response.status !== 202) { await response.body?.cancel(); throw new Error(`Peer returned ${response.status}`); }
    if (acknowledgement.parse(await response.json()).askId !== record.id) throw new Error("Peer acknowledged another ask");
  } catch (error) {
    console.warn(`Asking ${record.helperName} on ${record.helperNodeId} failed: ${(error as Error).message}`);
    await settle(record.id, { error: await unreachable(record) });
  }
}

/** Records the ask and starts the helper's turn, here or on its machine, without waiting for it. Availability and privacy are checked now, on every ask. */
export async function startAsk(input: { accountId: string; asker: PersonalAssistant; askerTurnRequestId: string; helperId: string; message: string; purpose: string }): Promise<AskRecord> {
  const helper = (await askableHelpers(input.asker)).find(view => view.id === input.helperId);
  if (!helper) throw new AskRefusal("No assistant has that id. Call list_assistants for the ones you may ask.");
  if (!helper.available) throw new AskRefusal(helper.reason!);
  const id = randomUUID();
  await insertAsk({ id, accountId: input.accountId, askerId: input.asker.id, askerName: input.asker.name, askerTurnRequestId: input.askerTurnRequestId, helperId: helper.id, helperName: helper.name, helperNodeId: helper.nodeId, purpose: input.purpose, question: input.message, startedAt: new Date().toISOString() });
  if (helper.nodeId === (await getClusterNode()).id) runHelperTurn(id, input.accountId, helper.id, input.message);
  else await sendAsk((await getAsk(id))!);
  return (await getAsk(id))!;
}

async function ownAsk(id: string, askerId: string): Promise<AskRecord> {
  const record = await getAsk(id);
  if (!record || record.askerId !== askerId) throw new AskRefusal("Ask not found.");
  return record;
}

/** The ask as it stands. A running ask served here whose helper turn no process runs lost that turn to a restart. */
async function current(record: AskRecord): Promise<AskRecord> {
  if (record.status !== "running" || live.has(record.id) || record.helperNodeId !== (await getClusterNode()).id) return record;
  await settle(record.id, { error: `Joint Bob restarted before ${record.helperName} answered. Ask again if you still need it.` });
  return (await getAsk(record.id))!;
}

const MAX_ANSWER = 1_000_000, MAX_ERROR = 100_000;
const statusReply = z.discriminatedUnion("status", [
  z.object({ status: z.literal("running") }).strict(),
  z.object({ status: z.literal("completed"), answer: z.string().max(MAX_ANSWER) }).strict(),
  z.object({ status: z.literal("failed"), error: z.string().max(MAX_ERROR) }).strict(),
]);
type StatusReply = z.infer<typeof statusReply>;
function readStatus(body: string): StatusReply | null {
  try { return statusReply.parse(JSON.parse(body)); } catch { return null; }
}
/** How the helper's machine says the ask stands, or null when it can't be reached. A reply that isn't a status ends the ask: reading it again won't help. */
async function helperStatus(record: AskRecord): Promise<StatusReply | null> {
  let body: string;
  try {
    const response = await postToTwin(record.helperNodeId, STATUS_TARGET, { askId: record.id, askerId: record.askerId }, 10_000);
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Peer returned ${response.status}`); }
    body = await response.text();
  } catch (error) {
    warnOnChange(`ask-status:${record.helperNodeId}`, `Reading asks from ${record.helperNodeId} failed: ${(error as Error).message}`);
    return null;
  }
  settled(`ask-status:${record.helperNodeId}`);
  const status = readStatus(body);
  if (status) return status;
  console.warn(`Ask ${record.id}: ${record.helperNodeId} sent a status that isn't one`);
  return { status: "failed", error: `${record.helperName}'s machine sent a reply Joint Bob couldn't read.` };
}

const polling = new Set<string>();
/** Copies the helper machine's result into the asker's record while someone waits for it. Only the status is read: the ask is never sent again. */
async function pollHelper(record: AskRecord): Promise<void> {
  if (polling.has(record.id)) return;
  polling.add(record.id);
  try {
    while (waiters.get(record.id)?.size) {
      const status = await helperStatus(record);
      if (status?.status === "completed") return await settle(record.id, { answer: status.answer });
      if (status?.status === "failed") return await settle(record.id, { error: status.error });
      if (status) failingSince.delete(record.id);
      else {
        const since = failingSince.get(record.id) ?? Date.now();
        failingSince.set(record.id, since);
        if (Date.now() - since >= 60_000) return await settle(record.id, { error: await unreachable(record) });
      }
      await new Promise(resolve => setTimeout(resolve, 3_000));
    }
  } finally {
    // The clock counts only failures while someone waits: reads in separate waits are not one outage.
    polling.delete(record.id); failingSince.delete(record.id);
  }
}

/** The asker's ask once it has finished, or still running after `maxMs` or when `signal` aborts. */
export async function waitForAsk(id: string, askerId: string, maxMs = 85_000, signal?: AbortSignal): Promise<AskRecord> {
  if (signal?.aborted) return ownAsk(id, askerId);
  let wake!: () => void;
  const woken = new Promise<void>(resolve => { wake = resolve; });
  const pending = waiters.get(id) ?? new Set<() => void>();
  pending.add(wake); waiters.set(id, pending);
  const timer = setTimeout(wake, maxMs);
  signal?.addEventListener("abort", wake, { once: true });
  try {
    const record = await current(await ownAsk(id, askerId));
    if (record.status === "running") {
      if (record.helperNodeId !== (await getClusterNode()).id) void pollHelper(record).catch(error => console.warn(`Could not follow ask ${id}`, error));
      await woken;
    }
    return await ownAsk(id, askerId);
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", wake); pending.delete(wake);
    if (!pending.size) waiters.delete(id);
  }
}

// Every ask this process starts or serves is recorded after this moment.
const loadedAt = new Date().toISOString();
/** At startup: helper turns don't survive a restart, so the asks they were answering here end. The asker's copy of an ask served elsewhere stays: that machine still has the answer. */
export async function failInterruptedAsks(): Promise<void> {
  for (const record of await runningAsksOn((await getClusterNode()).id, loadedAt)) await current(record);
}

const askStart = z.object({
  askId: z.string().uuid(), accountId: z.string().min(1).max(200), askerId: z.string().min(1).max(100), askerName: z.string().min(1).max(100),
  helperId: z.string().min(1).max(100), message: z.string().min(1).max(20000), purpose: z.string().min(1).max(60),
}).strict();
const askStatus = z.object({ askId: z.string().uuid(), askerId: z.string().min(1).max(100) }).strict();

async function ownersAccount(accountId: string): Promise<boolean> {
  const db = await clusterV2Database();
  return accountId === adminAccountId(db) && !accountOfSomeoneElse(accountId, db);
}

/** A twin's ask for one of this machine's assistants: checked here again, recorded under the asker's id, and run once however often it arrives. */
export async function serveAsk(body: unknown, response: ExpressResponse): Promise<void> {
  const input = askStart.parse(body);
  if (!await ownersAccount(input.accountId)) { sendError(response, 403, "Forbidden"); return; }
  const helper = await getPersonalAssistant(input.accountId, input.helperId);
  if (!helper) { sendError(response, 409, "That assistant isn't on this machine anymore."); return; }
  if (!await projectPrivateToOwner(helper.projectId)) { sendError(response, 409, sharedHelperReason(helper)); return; }
  const inserted = await insertAsk({ id: input.askId, accountId: input.accountId, askerId: input.askerId, askerName: input.askerName, askerTurnRequestId: null, helperId: helper.id, helperName: helper.name, helperNodeId: (await getClusterNode()).id, purpose: input.purpose, question: input.message, startedAt: new Date().toISOString() });
  if (inserted) runHelperTurn(input.askId, input.accountId, helper.id, input.message);
  response.status(202).json({ askId: input.askId });
}

/** How an ask served here stands, for the asker's machine. */
export async function serveAskStatus(body: unknown, response: ExpressResponse): Promise<void> {
  const input = askStatus.parse(body);
  const found = await getAsk(input.askId);
  if (!found || found.askerId !== input.askerId) { sendError(response, 404, "Ask not found."); return; }
  if (!await ownersAccount(found.accountId)) { sendError(response, 403, "Forbidden"); return; }
  const record = await current(found);
  // Never more than the asker's machine accepts.
  response.json({ status: record.status, ...(record.answer === null ? {} : { answer: record.answer.slice(0, MAX_ANSWER) }), ...(record.error === null ? {} : { error: record.error.slice(0, MAX_ERROR) }) });
}
