import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { runAsAccount, type ActingAccount } from "../account-context.js";
import { automationRunOf, type AutomationExecution } from "../automation-executions.js";
import {
  listBobMessages, listOpenBobMessages, noteBobRecheck, resolveBobMessage, reviseBobMessage, type BobMessage, type BobSettings, type OpenBobMessage,
} from "../control-center/bob-store.js";
import type { RatingDeps } from "../control-center/triggers-rate.js";
import { CANDIDATE_CHARACTERS, MAX_CANDIDATES, relateTrigger, type Candidate, type Candidates } from "../control-center/triggers-relate.js";
import { getTrigger, moveTriggerToBell, type Trigger } from "../control-center/triggers-store.js";
import { storedDigest } from "../conversation-digest.js";
import { getProject } from "../store.js";
import type { ProjectRecord } from "../types.js";
import { bobSessionFor } from "./control-center-session.js";
import { sharedProjectSessions } from "./sessions-helpers.js";

/**
 * Urgent webhook calls are alerts in Bob's chat, kept to what still needs the person:
 * - A webhook starts its own conversation for each call. Once that run started, the call is in hand: it waits in the bell.
 *   One whose run could not start is posted, with why.
 * - A call about the same problem as an open alert adds to it instead of a new one. One that another conversation in its
 *   project already works on, or the same problem as an alert from earlier today, waits in the bell.
 * - An alert leaves the chat for the bell when nobody acted on it for 6 hours, when its webhook's run started after it was
 *   posted, or when a conversation in its project took it up.
 */

let lifetimeMs = 6 * 3_600_000;
let runWaitMs = 60_000;
/** For tests: how long an alert stays, and how long a call waits for its webhook's run to start. */
export function setAlertTiming(timing: { lifetimeMs?: number; runWaitMs?: number }): void {
  lifetimeMs = timing.lifetimeMs ?? lifetimeMs;
  runWaitMs = timing.runWaitMs ?? runWaitMs;
}

const DAY_MS = 24 * 3_600_000;
/** At most this many alerts are asked about per person in one sweep. */
const SWEEP_QUESTIONS = 8;
const REPEATED = /\n\nHappened (\d+) times so far\.$/;
const IN_HAND = "urgent, but its webhook started a conversation on it";

type Run = Pick<AutomationExecution, "status" | "sessionId" | "error">;

/** An alert: an urgent webhook call Bob posted in the chat. A cleared one keeps its line, not its buttons. */
export const isAlert = (message: BobMessage): boolean => message.role === "system" && message.importance === "urgent" && Boolean(message.via?.startsWith("Webhook · "));

const cut = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, CANDIDATE_CHARACTERS);
const started = (run: Run | undefined): boolean => run?.status === "running" || run?.status === "succeeded";

function triggerOf(db: DatabaseSync, accountId: string, alert: BobMessage): Trigger | undefined {
  const id = alert.actions.find((action) => typeof action.data?.triggerId === "string")?.data?.triggerId;
  return typeof id === "string" ? getTrigger(db, accountId, id) : undefined;
}

/** The webhook's own run for a call, once it left the queue, or as it stands after waiting a while. */
export async function runOf(db: DatabaseSync, trigger: Trigger): Promise<Run | undefined> {
  if (!trigger.requestId) return undefined;
  const deadline = Date.now() + runWaitMs;
  for (;;) {
    const run = automationRunOf(db, trigger.requestId);
    if (run?.status !== "queued" || Date.now() >= deadline) return run;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/** What an alert says about its webhook's run, when that run could not start. */
export const runNote = (run: Run | undefined): string | null => run?.status === "failed" || run?.status === "cancelled" || run?.status === "interrupted"
  ? `Its webhook could not start a conversation for it${run.error ? `: ${run.error}` : "."}`
  : null;

/** Conversations in the project that run, or were active in the last day and are not closed, newest first. */
async function workingConversations(project: ProjectRecord, actor: ActingAccount): Promise<Array<Candidate & { title: string }>> {
  const session = bobSessionFor(actor.accountId, "alerts");
  if (!session) return [];
  const sessions = await runAsAccount(actor, () => sharedProjectSessions(project, session.userId, session.accountId));
  const now = Date.now();
  return sessions
    .filter((entry) => !entry.doneAt && (entry.running || (entry.updatedAt !== undefined && now - Date.parse(entry.updatedAt) < DAY_MS)))
    .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
    .slice(0, MAX_CANDIDATES)
    .map((entry, index) => {
      const summary = storedDigest(project.id, entry.conversationId ?? entry.id)?.summary;
      return { key: `w${index + 1}`, title: entry.title, text: cut(`“${entry.title}”${summary ? `: ${summary}` : ""}`) };
    });
}

interface Known { candidates: Candidates; alerts: Map<string, OpenBobMessage>; titles: Map<string, string> }

/** What a new call in the project is compared with: its open alerts, its working conversations, and its alerts cleared today. */
async function knownFor(db: DatabaseSync, actor: ActingAccount, project: ProjectRecord): Promise<Known> {
  const open = listOpenBobMessages(db, actor.accountId).filter((message) => isAlert(message) && !message.originNodeId && message.projectId === project.id).slice(-MAX_CANDIDATES);
  const work = await workingConversations(project, actor);
  const now = Date.now();
  const cleared = listBobMessages(db, actor.accountId, { project: project.id, cleared: true, limit: 200 })
    .filter((message) => isAlert(message) && now - Date.parse(message.resolvedAt!) < DAY_MS).reverse().slice(0, MAX_CANDIDATES);
  return {
    candidates: {
      open: open.map((alert, index) => ({ key: `a${index + 1}`, text: cut(alert.text) })),
      work: work.map(({ key, text }) => ({ key, text })),
      cleared: cleared.map((alert, index) => ({ key: `c${index + 1}`, text: cut(alert.text) })),
    },
    alerts: new Map(open.map((alert, index) => [`a${index + 1}`, alert])),
    titles: new Map(work.map(({ key, title }) => [key, title])),
  };
}

/** The same problem again: the open alert counts it, and its buttons act on the newest call. */
function addRepeat(db: DatabaseSync, accountId: string, alert: BobMessage, trigger: Trigger): void {
  const seen = Number(alert.text.match(REPEATED)?.[1] ?? 1) + 1;
  const actions = alert.actions.map((action) => typeof action.data?.triggerId === "string" ? { ...action, data: { ...action.data, triggerId: trigger.id } } : action);
  reviseBobMessage(db, accountId, alert.id, `${alert.text.replace(REPEATED, "")}\n\nHappened ${seen} times so far.`, actions);
}

/** An alert leaves the chat with why, and its call waits in the bell, as seen. */
function leaveChat(db: DatabaseSync, accountId: string, alert: BobMessage, trigger: Trigger | undefined, resolution: string, label: string): void {
  resolveBobMessage(db, accountId, alert.id, resolution);
  if (trigger) moveTriggerToBell(db, trigger.id, label, true);
}

export interface UrgentCall { db: DatabaseSync; actor: ActingAccount; project: ProjectRecord; trigger: Trigger; deps: RatingDeps; threshold: number; run: Run | undefined; post: () => void }

/** Where an urgent call goes: the bell when it is in hand or known, into an open alert when it repeats one, else a new alert. */
export async function placeUrgent(call: UrgentCall): Promise<void> {
  const { db, actor, trigger } = call;
  if (started(call.run)) { moveTriggerToBell(db, trigger.id, IN_HAND, false); return; }
  const known = await knownFor(db, actor, call.project);
  const relation = await relateTrigger(call.deps, trigger, known.candidates, call.threshold);
  const repeated = relation?.sameAs ? known.alerts.get(relation.sameAs) : undefined;
  if (relation?.fixedBy) {
    const label = `urgent, but “${known.titles.get(relation.fixedBy)}” is working on it`;
    moveTriggerToBell(db, trigger.id, label, false);
    if (repeated) leaveChat(db, actor.accountId, repeated, triggerOf(db, actor.accountId, repeated), `“${known.titles.get(relation.fixedBy)}” is working on it.`, label);
  } else if (repeated) addRepeat(db, actor.accountId, repeated, trigger);
  else if (relation?.knownAs) moveTriggerToBell(db, trigger.id, "urgent, but the same problem as an alert you had earlier today", false);
  else call.post();
}

/** Why an alert leaves now from facts alone: nobody acted on it in time, or its webhook's run started after it was posted. */
function settledAlert(db: DatabaseSync, alert: BobMessage, trigger: Trigger | undefined): { resolution: string; label: string } | null {
  if (Date.now() - Date.parse(trigger?.receivedAt ?? alert.createdAt) > lifetimeMs) return { resolution: "No one acted on it for 6 hours, so it moved to the bell.", label: "urgent; nobody acted on it in the chat for 6 hours" };
  if (trigger?.requestId && started(automationRunOf(db, trigger.requestId))) return { resolution: "Its webhook started a conversation on it.", label: IN_HAND };
  return null;
}

/**
 * Checks one person's open alerts: what the facts settle leaves the chat, and the decision model is asked whether a
 * conversation in the project took up the rest. Each alert is asked again only when the project's conversations changed.
 */
export async function sweepAlerts(db: DatabaseSync, actor: ActingAccount, settings: BobSettings, depsFor: (project: ProjectRecord) => Promise<RatingDeps>): Promise<number> {
  const work = new Map<string, Awaited<ReturnType<typeof workingConversations>>>();
  let asked = 0;
  let left = 0;
  for (const alert of listOpenBobMessages(db, actor.accountId).filter((message) => isAlert(message) && !message.originNodeId)) {
    const trigger = triggerOf(db, actor.accountId, alert);
    const settled = settledAlert(db, alert, trigger);
    if (settled) { leaveChat(db, actor.accountId, alert, trigger, settled.resolution, settled.label); left += 1; continue; }
    if (!settings.monitoring || !trigger || asked >= SWEEP_QUESTIONS) continue;
    const project = await runAsAccount(actor, () => getProject(trigger.projectId));
    if (!project) continue;
    if (!work.has(project.id)) work.set(project.id, await workingConversations(project, actor));
    const conversations = work.get(project.id)!;
    if (!conversations.length) continue;
    const hash = createHash("sha256").update(JSON.stringify([alert.text, conversations.map(({ title }) => title)])).digest("hex");
    if (hash === alert.recheckHash) continue;
    asked += 1;
    // Only the decision model is asked here: an agent run for each open alert every few minutes would cost too much.
    const deps = { ...await depsFor(project), agent: undefined };
    const relation = await relateTrigger(deps, trigger, { open: [], work: conversations, cleared: [] }, settings.threshold);
    if (deps.ask) noteBobRecheck(db, actor.accountId, alert.id, hash);
    const title = relation?.fixedBy ? conversations.find(({ key }) => key === relation.fixedBy)?.title : undefined;
    if (!title) continue;
    leaveChat(db, actor.accountId, alert, trigger, `“${title}” is working on it.`, `urgent, but “${title}” is working on it`);
    left += 1;
  }
  return left;
}
