import type { DatabaseSync } from "node:sqlite";
import { runAsAccount, type ActingAccount } from "../account-context.js";
import { automationRunOf, webhookRunsSince } from "../automation-executions.js";
import { appendBobMessage, listBobAccounts, listOpenBobMessages, readBobSettings, resolveBobMessage, type BobSettings } from "../control-center/bob-store.js";
import { subjectOf } from "../control-center/recheck.js";
import type { RatingDeps } from "../control-center/triggers-rate.js";
import { answerDigest, judgeOutcome, knownOutcome, rememberOutcome, type OutcomeAnswer } from "../control-center/triggers-outcome.js";
import {
  dismissTriggers, followedTriggers, followsCallsIn, labelTrigger, matchTriggerRuns, oldestUnmatchedTrigger, type Trigger,
} from "../control-center/triggers-store.js";
import { conversationsStartedBy } from "../conversation-starts.js";
import { getProject } from "../store.js";
import type { ProjectRecord, SessionSummary } from "../types.js";
import { bobSessionFor } from "./control-center-session.js";
import { triggerDatabase, triggerRatingDeps } from "./control-center-triggers.js";
import { loadConversationMessages } from "./conversation-turns.js";
import { onConversationTurn } from "./harness-sessions.js";
import { broadcastToAllClients } from "./realtime.js";
import { sharedProjectSessions } from "./sessions-helpers.js";
import { flags } from "./state.js";

/**
 * Bob follows each webhook call to the conversation its run started, and settles the call by how that conversation ended:
 * - Settled (it fixed it, found an existing fix, or found nothing wrong): the call leaves the bell, and its alert the chat,
 *   with why under ✓ Cleared.
 * - In progress: the call waits in the bell, labelled with the conversation on it; older calls it also covers leave.
 * - Needs you: one item in Bob's chat about that conversation (Open, Reply, Done), and the call leaves the bell.
 * A run that opened a worktree and started another conversation there is followed to that one: the start is recorded
 * (conversation-starts.ts), and for calls from before that, it is the conversation the run's last answer names.
 * The decision model judges the conversation's last answer, and Bob's agent when it is less sure than the threshold; one
 * answer is judged once. Calls are checked when a turn ends in their project, and once when the server starts.
 */

export interface OutcomeSources {
  project(projectId: string, actor: ActingAccount): Promise<ProjectRecord | undefined>;
  sessions(project: ProjectRecord, actor: ActingAccount): Promise<SessionSummary[]>;
  lastAnswer(project: ProjectRecord, conversationId: string): Promise<string>;
  deps(actor: ActingAccount, settings: BobSettings, project: ProjectRecord): Promise<RatingDeps>;
}

const realSources: OutcomeSources = {
  project: (projectId, actor) => runAsAccount(actor, () => getProject(projectId)),
  async sessions(project, actor) {
    const session = bobSessionFor(actor.accountId, "outcomes");
    return session ? runAsAccount(actor, () => sharedProjectSessions(project, session.userId, session.accountId)) : [];
  },
  async lastAnswer(project, conversationId) {
    const { messages } = await loadConversationMessages(project, conversationId);
    return [...messages].reverse().find((message) => message.role === "assistant" && message.text.trim())?.text.trim() ?? "";
  },
  deps: (actor, settings, project) => triggerRatingDeps(actor, settings, project),
};

const idOf = (session: SessionSummary): string => session.conversationId ?? session.id;
const newest = (sessions: SessionSummary[]): SessionSummary | undefined => [...sessions].sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))[0];

/** The conversation that works on a call: the one its run started, or the run's own. */
async function investigationOf(db: DatabaseSync, project: ProjectRecord, sessions: SessionSummary[], runSessionId: string, sources: OutcomeSources): Promise<SessionSummary | undefined> {
  const find = (id: string) => sessions.find((session) => session.id === id || idOf(session) === id);
  const started = conversationsStartedBy(db, project.id, runSessionId).map((start) => find(start.childSessionId)).filter((session) => session !== undefined);
  if (started.length) return newest(started);
  const run = find(runSessionId);
  if (!run || run.running) return run;
  // Started before starts were recorded: the conversation the run's answer names by its id.
  const answer = await sources.lastAnswer(project, idOf(run));
  return newest(sessions.filter((session) => session !== run && answer.includes(idOf(session)))) ?? run;
}

const alertsOf = (db: DatabaseSync, accountId: string, trigger: Trigger) =>
  listOpenBobMessages(db, accountId).filter((message) => message.actions.some((action) => action.data?.triggerId === trigger.id));

function settle(db: DatabaseSync, accountId: string, trigger: Trigger, title: string, judged: OutcomeAnswer): void {
  dismissTriggers(db, accountId, [trigger.id]);
  labelTrigger(db, trigger.id, `settled: ${judged.reason}`);
  for (const alert of alertsOf(db, accountId, trigger)) resolveBobMessage(db, accountId, alert.id, `Settled by “${title}”: ${judged.reason}`);
}

/** One item in the chat about the conversation, unless one is open already; the call itself leaves the bell. */
function needsYou(db: DatabaseSync, accountId: string, trigger: Trigger, project: ProjectRecord, investigation: SessionSummary, judged: OutcomeAnswer): void {
  const conversationId = idOf(investigation);
  const told = listOpenBobMessages(db, accountId).some((message) => {
    const subject = subjectOf(message);
    return subject?.kind === "conversation" && subject.projectId === project.id && subject.conversationId === conversationId;
  });
  if (!told) {
    appendBobMessage(db, accountId, {
      role: "bob", importance: "needs-you", projectId: project.id, projectName: project.name, via: `Webhook · ${trigger.webhookName} · ${judged.by}`,
      text: `${trigger.title}\n“${investigation.title}” needs you: ${judged.reason}`,
      actions: [{ id: "open", label: "Open", data: { open: { projectId: project.id, conversationId, title: investigation.title } } }],
    });
  }
  dismissTriggers(db, accountId, [trigger.id]);
  labelTrigger(db, trigger.id, `needs you: “${investigation.title}”, in Bob's chat`);
  for (const alert of alertsOf(db, accountId, trigger)) resolveBobMessage(db, accountId, alert.id, `“${investigation.title}” needs you; Bob's message about it says why.`);
}

interface Pass { db: DatabaseSync; actor: ActingAccount; settings: BobSettings; sources: OutcomeSources; projects: Map<string, ProjectRecord | undefined>; sessions: Map<string, SessionSummary[]> }

/** The call's project and the conversation working on it, once its run started. */
async function investigationFor(pass: Pass, trigger: Trigger): Promise<{ project: ProjectRecord; investigation: SessionSummary } | null> {
  const run = automationRunOf(pass.db, trigger.requestId!);
  if (!run?.sessionId || (run.status !== "running" && run.status !== "succeeded")) return null;
  if (!pass.projects.has(trigger.projectId)) pass.projects.set(trigger.projectId, await pass.sources.project(trigger.projectId, pass.actor));
  const project = pass.projects.get(trigger.projectId);
  if (!project) return null;
  if (!pass.sessions.has(project.id)) pass.sessions.set(project.id, await pass.sources.sessions(project, pass.actor));
  const investigation = await investigationOf(pass.db, project, pass.sessions.get(project.id)!, run.sessionId, pass.sources);
  return investigation ? { project, investigation } : null;
}

/** How the conversation's last answer leaves the call: judged once per answer; null when nothing could tell. */
async function outcomeOf(pass: Pass, trigger: Trigger, project: ProjectRecord, investigation: SessionSummary): Promise<OutcomeAnswer | null> {
  const answer = await pass.sources.lastAnswer(project, idOf(investigation));
  if (!answer) return null;
  const hash = answerDigest(answer);
  const known = knownOutcome(pass.db, project.id, idOf(investigation), hash);
  if (known) return known;
  const judged = await judgeOutcome(await pass.sources.deps(pass.actor, pass.settings, project), trigger, { title: investigation.title, answer }, pass.settings.threshold);
  if (judged) rememberOutcome(pass.db, project.id, idOf(investigation), hash, judged);
  return judged;
}

/** Still being worked on: the newest call about the conversation says so in the bell, and older ones leave. */
function inHand(db: DatabaseSync, accountId: string, trigger: Trigger, key: string, title: string, reason: string | null, onIt: Set<string>): boolean {
  if (onIt.has(key)) {
    dismissTriggers(db, accountId, [trigger.id]);
    labelTrigger(db, trigger.id, `in hand: a newer call about “${title}” covers it`);
    return true;
  }
  onIt.add(key);
  const label = reason ? `in hand: “${title}”: ${reason}` : `in hand: “${title}” is working on it`;
  // An urgent one is an alert in the chat, which has its own checks; it comes to the bell from there.
  if (trigger.urgency === "urgent" || trigger.label === label) return false;
  labelTrigger(db, trigger.id, label);
  return true;
}

/** One call, followed to its conversation: true when anything about it changed. */
async function follow(pass: Pass, trigger: Trigger, onIt: Set<string>): Promise<boolean> {
  const found = await investigationFor(pass, trigger);
  if (!found) return false;
  const { project, investigation } = found;
  // You closed the conversation working on it: that settles the call, with nothing to ask.
  if (investigation.doneAt && !investigation.running) {
    settle(pass.db, pass.actor.accountId, trigger, investigation.title, { outcome: "settled", reason: "it was marked done.", by: "you" });
    return true;
  }
  const judged = investigation.running ? null : await outcomeOf(pass, trigger, project, investigation);
  if (!investigation.running && !judged) return false;
  if (judged?.outcome === "settled") { settle(pass.db, pass.actor.accountId, trigger, investigation.title, judged); return true; }
  if (judged?.outcome === "needs-you") { needsYou(pass.db, pass.actor.accountId, trigger, project, investigation, judged); return true; }
  return inHand(pass.db, pass.actor.accountId, trigger, `${project.id}:${idOf(investigation)}`, investigation.title, judged?.reason ?? null, onIt);
}

/** Follows one person's calls, newest first. Returns whether anything they see changed. */
export async function settleFollowedCalls(db: DatabaseSync, actor: ActingAccount, sources: OutcomeSources = realSources): Promise<boolean> {
  const settings = readBobSettings(db, actor.accountId);
  if (!settings.monitoring) return false;
  const pass: Pass = { db, actor, settings, sources, projects: new Map(), sessions: new Map() };
  const onIt = new Set<string>();
  let changed = false;
  for (const trigger of followedTriggers(db, actor.accountId)) {
    try { changed = await follow(pass, trigger, onIt) || changed; }
    catch (error) { console.warn(`Bob could not follow the call "${trigger.title}"`, error instanceof Error ? error.message : error); }
  }
  return changed;
}

// ── When ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Turns often end in a row: one check follows them. */
const SETTLE_DELAY_MS = 10_000;
let chain: Promise<void> = Promise.resolve();
let timer: NodeJS.Timeout | undefined;

async function settleEveryone(): Promise<void> {
  // Conversations are listed fully only once the server finished starting.
  if (!flags.startupReady) { settleSoon(); return; }
  const db = await triggerDatabase();
  for (const actor of listBobAccounts(db)) {
    if (await settleFollowedCalls(db, actor)) broadcastToAllClients({ type: "controlCenterChanged" }, actor.accountId);
  }
}

/** Checks again shortly; checks never overlap. */
export function settleSoon(): void {
  clearTimeout(timer);
  timer = setTimeout(() => {
    chain = chain.then(settleEveryone).catch((error) => console.warn("Bob could not follow his webhook calls", error instanceof Error ? error.message : error));
  }, SETTLE_DELAY_MS).unref();
}

/** Calls stored before their run was kept with them are matched to it, so they can be followed too. */
async function matchOldCalls(): Promise<void> {
  const db = await triggerDatabase();
  const oldest = oldestUnmatchedTrigger(db);
  if (!oldest) return;
  const matched = matchTriggerRuns(db, webhookRunsSince(db, new Date(Date.parse(oldest) - 60_000).toISOString()));
  if (matched) console.log(`Bob matched ${matched} earlier webhook calls to their runs`);
}

let started = false;

/** Starts following webhook calls: once now, and whenever a turn ends in a project with calls to follow. */
export function startOutcomeChecks(): void {
  if (started) return;
  started = true;
  chain = chain.then(matchOldCalls).catch((error) => console.warn("Bob could not match earlier webhook calls", error instanceof Error ? error.message : error));
  settleSoon();
  onConversationTurn((shared) => {
    void triggerDatabase().then((db) => { if (followsCallsIn(db, shared.projectId)) settleSoon(); })
      .catch((error) => console.warn("Bob could not follow his webhook calls", error instanceof Error ? error.message : error));
  });
}
