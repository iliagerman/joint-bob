import type { DatabaseSync } from "node:sqlite";
import { actingAccountFromSession, runAsAccount, type ActingAccount } from "../account-context.js";
import { askSystemOneChoices } from "../classifiers/typesafe.js";
import { BobActionError, bobSays, registerBobAction } from "../control-center/bob-actions.js";
import { appendBobMessage, bobDatabase, listBobAccounts, readBobSettings, type BobSettings } from "../control-center/bob-store.js";
import { recordBobStart } from "../control-center/started.js";
import { investigationBrief } from "../control-center/triggers-brief.js";
import { describeCall, oneLine } from "../control-center/triggers-describe.js";
import { onWebhookCall, type AcceptedWebhookCall } from "../control-center/triggers-observe.js";
import { rateTrigger, type RatingDeps } from "../control-center/triggers-rate.js";
import {
  clearSnooze, dueSnoozedTriggers, ensureTriggerSchema, getTrigger, insertTrigger, markTriggersSeen, nextSnoozeWake, rateStoredTrigger, snoozeTrigger, type Trigger,
} from "../control-center/triggers-store.js";
import { createQuickNote } from "../quick-notes.js";
import { getProject } from "../store.js";
import type { HarnessId, ProjectRecord } from "../types.js";
import { bobDecisionModel } from "./bob.js";
import { runGitReview } from "./git-review-run.js";
import { iconHarnessId } from "./label-icon.js";
import { assertProjectEditable, ProjectLockedError, projectsWithSharedNames } from "./projects.js";
import { launchQuickNote, QuickNoteLaunchError } from "./quick-note-dispatch.js";
import { broadcastToAllClients } from "./realtime.js";

/**
 * Incoming triggers. Each call a webhook accepts becomes a trigger for every person who uses Bob and can see the
 * webhook's project. Unless that person paused Bob, it is rated urgent or not: urgent ones are posted in Bob's chat with
 * buttons, the rest wait in the bell. Bob does nothing else with a trigger; the one thing it can start, when the person
 * presses the button, is a read-only investigation. The payload is outside text and is only ever read as data.
 */

export const INVESTIGATE = "trigger.investigate";
export const OPEN = "trigger.open";
export const SNOOZE = "trigger.snooze";
export const SNOOZE_MS = 3_600_000;

export async function triggerDatabase(): Promise<DatabaseSync> {
  const db = await bobDatabase();
  ensureTriggerSchema(db);
  return db;
}

/** Triggers being rated right now. They are not listed until the rating is in, so an urgent one never flashes in the bell. */
const rating = new Set<string>();
export const isBeingRated = (id: string): boolean => rating.has(id);

const changed = (accountId: string): void => broadcastToAllClients({ type: "controlCenterChanged" }, accountId);

// ── Rating ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The decision model Bob uses, and a tool-less agent turn in the webhook's own project. */
async function bobRatingDeps(actor: ActingAccount, settings: BobSettings, project: ProjectRecord): Promise<RatingDeps> {
  const projects = await runAsAccount(actor, () => projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false }));
  const model = await runAsAccount(actor, () => bobDecisionModel([project, ...projects.filter((candidate) => candidate.id !== project.id)], settings));
  return {
    stateCharacters: model?.target.stateCharacters ?? 0,
    ...model ? { ask: async (state, questions) => askSystemOneChoices(model.target, state, questions, model.apiKey) } : {},
    agent: async (step) => (await runGitReview({
      projectId: project.id, cwd: project.path, harnessId: (settings.harnessId || iconHarnessId()) as HarnessId,
      provider: settings.provider, modelId: settings.modelId, thinkingLevel: settings.thinkingLevel,
      selection: { scope: "context", label: "Incoming trigger" }, question: "", diff: step.material, instructions: step.instructions,
    })).answer,
  };
}

let ratingDeps: typeof bobRatingDeps = bobRatingDeps;

/** For tests: what rates a trigger, instead of the decision model and Bob's agent. */
export function setTriggerRatingDeps(build: typeof bobRatingDeps): void { ratingDeps = build; }

/** The line under a trigger's message in the chat: where it came from and who rated it. */
function viaFor(trigger: Trigger): string {
  const by = trigger.ratedBy === "decision-model" ? `decision model ${Math.round((trigger.confidence ?? 0) * 100)}%` : trigger.label;
  return `Webhook · ${trigger.webhookName} · ${by}`;
}

function postUrgent(db: DatabaseSync, trigger: Trigger, via: string): void {
  appendBobMessage(db, trigger.accountId, {
    role: "system", importance: "urgent", projectId: trigger.projectId, projectName: trigger.projectName,
    text: [trigger.title, trigger.summary, trigger.reason ? `Why: ${trigger.reason}` : ""].filter(Boolean).join("\n"), via,
    actions: [
      { id: INVESTIGATE, label: "Investigate (read-only)", style: "primary", data: { triggerId: trigger.id } },
      { id: OPEN, label: "Open", data: { triggerId: trigger.id, projectId: trigger.projectId, projectName: trigger.projectName } },
      { id: SNOOZE, label: "Snooze 1h", data: { triggerId: trigger.id } },
    ],
  });
}

/** At most this many are rated at once, so a flood of calls cannot start a flood of agent runs; the rest wait their turn. */
const MAX_RATINGS = 3;
let ratingNow = 0;
const ratingQueue: Array<() => void> = [];

async function inTurn<T>(work: () => Promise<T>): Promise<T> {
  // A waiter is handed the finished one's place, so the count never goes over.
  if (ratingNow >= MAX_RATINGS) await new Promise<void>((resolve) => ratingQueue.push(resolve));
  else ratingNow += 1;
  try { return await work(); } finally {
    const next = ratingQueue.shift();
    if (next) next(); else ratingNow -= 1;
  }
}

async function rateAndPost(db: DatabaseSync, actor: ActingAccount, settings: BobSettings, project: ProjectRecord, trigger: Trigger): Promise<void> {
  const paused = (): boolean => !readBobSettings(db, actor.accountId).monitoring;
  // Paused while it waited its turn or was being rated: nothing is rated or posted, and it waits unrated in the bell.
  const result = await inTurn(async () => paused() ? null : rateTrigger(await ratingDeps(actor, settings, project), trigger, settings.threshold));
  if (!result || paused()) return;
  rateStoredTrigger(db, trigger.id, result);
  if (result.urgency === "urgent") postUrgent(db, getTrigger(db, actor.accountId, trigger.id)!, viaFor({ ...trigger, ...result }));
}

/** Takes in one accepted call: stores it for each person it concerns, and rates it for those who have not paused Bob. */
export async function receiveWebhookCall({ webhook, call }: AcceptedWebhookCall): Promise<void> {
  // A webhook behind a connected Telegram bot is a chat with an assistant, not something arriving.
  if (webhook.reply) return;
  const described = describeCall(webhook.name, call);
  const db = await triggerDatabase();
  const receivedAt = new Date().toISOString();
  await Promise.all(listBobAccounts(db).map(async (actor) => {
    const project = await runAsAccount(actor, () => getProject(webhook.target.projectId));
    if (!project) return;
    const trigger = insertTrigger(db, actor.accountId, { webhookId: webhook.id, webhookName: webhook.name, projectId: project.id, projectName: project.name, receivedAt, ...described });
    const settings = readBobSettings(db, actor.accountId);
    if (!settings.monitoring) { changed(actor.accountId); return; }
    rating.add(trigger.id);
    try { await rateAndPost(db, actor, settings, project, trigger); } finally { rating.delete(trigger.id); changed(actor.accountId); }
  }));
}

onWebhookCall(receiveWebhookCall);

// ── The buttons on an urgent trigger ────────────────────────────────────────────────────────────────────────

function triggerOf(db: DatabaseSync, accountId: string, data: Record<string, unknown> | undefined): Trigger {
  const trigger = typeof data?.triggerId === "string" ? getTrigger(db, accountId, data.triggerId) : undefined;
  if (!trigger) throw new BobActionError(404, "That trigger is no longer there");
  return trigger;
}

registerBobAction(INVESTIGATE, ({ db, session, action }) => runAsAccount(actingAccountFromSession(session), async () => {
  const trigger = triggerOf(db, session.accountId, action.data);
  const project = await getProject(trigger.projectId);
  if (!project) throw new BobActionError(404, "That project is no longer available to you");
  const settings = readBobSettings(db, session.accountId);
  try {
    await assertProjectEditable(project);
    // The ordinary way Bob starts work: a conversation in the project, marked as started by Bob. The brief says read-only and quotes the call as data.
    const note = createQuickNote({ projectId: project.id, title: oneLine(`Investigate (read-only): ${trigger.title}`, 80), content: investigationBrief(trigger), harnessId: settings.harnessId || iconHarnessId() });
    const started = await launchQuickNote(note.id);
    if (started.sessionId) await recordBobStart(project.id, started.sessionId);
  } catch (error) {
    if (error instanceof QuickNoteLaunchError) throw new BobActionError(error.status, error.message);
    if (error instanceof ProjectLockedError) throw new BobActionError(409, error.message);
    throw error;
  }
  markTriggersSeen(db, session.accountId, [trigger.id]);
  return [bobSays(db, session, `Started a read-only investigation in ${project.name}. It is on the board now; I'll show what it is doing there. It looks and reports; it changes nothing.`, {
    importance: "fyi", projectId: project.id, projectName: project.name, via: `Webhook · ${trigger.webhookName} · read-only investigation`,
  })];
}));

// The page opens the webhook itself when this button is pressed (it listens for `control-bob-action`). A button that only
// opens something keeps the message's other buttons, so they are put back after the one-press rule took them off.
registerBobAction(OPEN, async ({ db, session, message, action }) => {
  const trigger = triggerOf(db, session.accountId, action.data);
  markTriggersSeen(db, session.accountId, [trigger.id]);
  db.prepare("UPDATE control_center_bob_messages SET actions = ? WHERE account_id = ? AND id = ?").run(JSON.stringify(message.actions), session.accountId, message.id);
});

registerBobAction(SNOOZE, async ({ db, session, action }) => {
  const trigger = triggerOf(db, session.accountId, action.data);
  if (!snoozeTrigger(db, session.accountId, trigger.id, new Date(Date.now() + SNOOZE_MS))) throw new BobActionError(409, "That trigger was dismissed");
  rearmSnoozeTimer();
  return [bobSays(db, session, `Snoozed for an hour: ${trigger.title}. I'll post it here again then.`, { importance: "fyi", projectId: trigger.projectId, projectName: trigger.projectName, via: `Webhook · ${trigger.webhookName}` })];
});

// ── Snoozes come back ───────────────────────────────────────────────────────────────────────────────────────

/** Posts again every snoozed trigger that is due. While Bob is paused nothing is posted; the trigger waits in the bell instead. */
export async function bringBackSnoozed(now = Date.now()): Promise<void> {
  const db = await triggerDatabase();
  for (const trigger of dueSnoozedTriggers(db, now)) {
    clearSnooze(db, trigger.id);
    if (trigger.state === "dismissed") continue;
    if (readBobSettings(db, trigger.accountId).monitoring) postUrgent(db, trigger, `${viaFor(trigger)} · snoozed, back now`);
    else { rateStoredTrigger(db, trigger.id, { urgency: "unrated", ratedBy: "none", confidence: null, label: "not rated: Bob was paused when its snooze ended", reason: "" }); changed(trigger.accountId); }
  }
}

let timer: NodeJS.Timeout | undefined;
let generation = 0;

/**
 * One timer, always pointed at the earliest snooze. Nothing polls: a snooze set or brought back calls this to move it.
 * Started once when the server begins listening, so snoozes saved before a restart come back too.
 */
export function rearmSnoozeTimer(): void {
  const mine = ++generation;
  void (async () => {
    const db = await triggerDatabase();
    // A later call replaced this one while the database was opening.
    if (mine !== generation) return;
    clearTimeout(timer);
    timer = undefined;
    const next = nextSnoozeWake(db);
    if (next === null) return;
    // Snoozes last an hour, far under the longest delay a timer takes.
    timer = setTimeout(() => {
      timer = undefined;
      void bringBackSnoozed().catch((error) => console.warn("Bob could not bring back a snoozed trigger", error instanceof Error ? error.message : error)).finally(rearmSnoozeTimer);
    }, Math.max(next - Date.now(), 0));
    timer.unref();
  })().catch((error) => console.warn("Bob could not set the snooze timer", error instanceof Error ? error.message : error));
}

/** For tests: forget the timer. */
export function stopSnoozeTimer(): void {
  generation += 1;
  clearTimeout(timer);
  timer = undefined;
}
