import { randomUUID } from "node:crypto";

/**
 * Moving conversations to another machine. This file decides what can move and runs a batch; everything that touches
 * the cluster (ownership transfer, stopping a turn, sending a message) comes in through `MoveEnvironment`, so the
 * rules here are tested without a second machine. `moves-runtime.ts` supplies the real environment.
 *
 * A conversation always moves through the existing ownership transfer. Nothing here replays what an interrupted turn
 * was doing: the only message ever sent is the one that tells the agent to look at the state first.
 */

/** "after-turn" waits for the running turn to end; "now" stops it, moves, then tells the agent to continue. */
export type MoveMode = "after-turn" | "now";

export interface MoveRef { projectId: string; conversationId: string }

export interface MoveNode { id: string; name: string; local: boolean; online: boolean }

/** One conversation as the mover reads it, looked up on the server so the page cannot say what a conversation is. */
export interface MoveConversation extends MoveRef {
  projectName: string;
  sessionId: string;
  path: string;
  title: string;
  harnessId: string;
  harnessLabel: string;
  /** What the conversation last ran with, as the list shows it. */
  model: string | null;
  /** The machine that owns and runs it now; null when it was never claimed. */
  ownerNodeId: string | null;
  turnRunning: boolean;
  /** Set when the conversation cannot move this way at all: a ticket's conversation, a read-only transcript. */
  fixedReason: string | null;
}

export interface MoveEnvironment {
  nodes(): Promise<MoveNode[]>;
  /** The conversation as it is right now; null when it is gone. */
  resolve(ref: MoveRef): Promise<MoveConversation | null>;
  /** Why the conversation cannot run on that machine (harness, model, login, project); empty when it can. */
  blockers(conversation: MoveConversation, target: MoveNode): Promise<string[]>;
  /** Ends the running turn on the machine that owns the conversation. */
  stopTurn(conversation: MoveConversation, owner: MoveNode | null): Promise<void>;
  /** The existing ownership transfer, run on `target`. Throws with the reason when it is refused. */
  takeOwnership(conversation: MoveConversation, target: MoveNode): Promise<void>;
  /** Queues one message in the conversation on `target`, once. Never retried. */
  sendMessage(conversation: MoveConversation, target: MoveNode, text: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export class MoveError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export type MoveVerdict = "ready" | "there" | "cannot";

export interface MovePlanEntry {
  ref: MoveRef;
  title: string;
  projectName: string;
  fromName: string | null;
  turnRunning: boolean;
  verdict: MoveVerdict;
  /** Why it cannot move; empty otherwise. */
  reasons: string[];
  conversation: MoveConversation | null;
}

export interface MovePlan { target: MoveNode; nodes: MoveNode[]; entries: MovePlanEntry[] }

/** The one message a stopped conversation gets on its new machine. */
export function continueMessage(from: string, to: string): string {
  return `Continue where you stopped: you were moved from ${from} to ${to}. Check what was half done before repeating anything.`;
}

const nameOf = (nodes: MoveNode[], id: string | null): string | null => id ? nodes.find((node) => node.id === id)?.name ?? "another machine" : null;

async function planOne(env: MoveEnvironment, ref: MoveRef, target: MoveNode, nodes: MoveNode[]): Promise<MovePlanEntry> {
  const conversation = await env.resolve(ref);
  if (!conversation) return { ref, title: ref.conversationId, projectName: "", fromName: null, turnRunning: false, verdict: "cannot", reasons: ["The conversation was not found"], conversation: null };
  const entry = { ref, title: conversation.title, projectName: conversation.projectName, fromName: nameOf(nodes, conversation.ownerNodeId), turnRunning: conversation.turnRunning, conversation };
  if (conversation.fixedReason) return { ...entry, verdict: "cannot", reasons: [conversation.fixedReason] };
  if (conversation.ownerNodeId === target.id) return { ...entry, verdict: "there", reasons: [`Already on ${target.name}`] };
  const reasons = await env.blockers(conversation, target);
  return { ...entry, verdict: reasons.length ? "cannot" : "ready", reasons };
}

/** Checks each conversation against the target machine: what will move, what is already there, what cannot and why. */
export async function planMoves(env: MoveEnvironment, refs: MoveRef[], targetId: string): Promise<MovePlan> {
  const nodes = await env.nodes();
  const target = nodes.find((node) => node.id === targetId);
  if (!target) throw new MoveError(404, "That machine is not one of yours");
  const seen = new Set<string>();
  const unique = refs.filter((ref) => { const key = `${ref.projectId}:${ref.conversationId}`; return seen.has(key) ? false : Boolean(seen.add(key)); });
  return { target, nodes, entries: await Promise.all(unique.map((ref) => planOne(env, ref, target, nodes))) };
}

// ── Running a batch ────────────────────────────────────────────────────────────────────────────────────────

export type MoveStatus = "waiting" | "stopping" | "moving" | "continuing" | "moved" | "there" | "cannot" | "failed" | "cancelled";
const FINISHED: readonly MoveStatus[] = ["moved", "there", "cannot", "failed", "cancelled"];
export const moveFinished = (status: MoveStatus): boolean => FINISHED.includes(status);

export interface MoveEntryState {
  projectId: string;
  conversationId: string;
  title: string;
  projectName: string;
  fromName: string | null;
  status: MoveStatus;
  detail: string | null;
  /** True when its running turn was stopped, so it was told to continue on the new machine. */
  stopped: boolean;
  /** For a stopped one: whether the continue message was queued. Null when none was due. */
  continued: boolean | null;
}

export interface MoveJob {
  id: string;
  accountId: string;
  mode: MoveMode;
  targetId: string;
  targetName: string;
  startedAt: string;
  finishedAt: string | null;
  cancelled: boolean;
  entries: MoveEntryState[];
}

export interface MoveRunOptions {
  /** How often a waiting conversation is looked at again. */
  pollMs?: number;
  /** How long "after the current turn" waits before giving up on one conversation. */
  waitLimitMs?: number;
  /** How many times a turn that keeps running is told to stop, and how long each attempt is given. */
  stopAttempts?: number;
  stopWaitMs?: number;
  /** How many conversations are stopped, moved and told to continue at the same time. */
  concurrency?: number;
}

const DEFAULTS = { pollMs: 5_000, waitLimitMs: 6 * 60 * 60_000, stopAttempts: 3, stopWaitMs: 20_000, concurrency: 3 } satisfies Required<MoveRunOptions>;

const jobs = new Map<string, MoveJob>();
/** Conversations a running job is handling, so two batches never move the same one. */
const busy = new Set<string>();
const RETAIN_MS = 60 * 60_000;

const keyOf = (ref: MoveRef): string => `${ref.projectId}:${ref.conversationId}`;

function limiter(size: number): <T>(work: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  return async (work) => {
    // A finishing task hands its place straight to the next one in line, so the count never overshoots.
    if (active >= size) await new Promise<void>((resolve) => queue.push(resolve));
    else active += 1;
    try { return await work(); } finally {
      const next = queue.shift();
      if (next) next(); else active -= 1;
    }
  };
}

class Stopped extends Error {}

async function waitForIdle(env: MoveEnvironment, job: MoveJob, ref: MoveRef, options: Required<MoveRunOptions>): Promise<MoveConversation> {
  const deadline = Date.now() + options.waitLimitMs;
  for (;;) {
    if (job.cancelled) throw new Stopped("Cancelled before it moved");
    const current = await env.resolve(ref);
    if (!current) throw new Error("The conversation was not found any more");
    if (!current.turnRunning) return current;
    if (Date.now() > deadline) throw new Error(`Its turn did not end within ${Math.round(options.waitLimitMs / 3_600_000)} hours, so it stays where it is`);
    await env.sleep(options.pollMs);
  }
}

async function stopRunningTurn(env: MoveEnvironment, ref: MoveRef, owner: MoveNode | null, options: Required<MoveRunOptions>): Promise<MoveConversation> {
  for (let attempt = 1; attempt <= options.stopAttempts; attempt += 1) {
    const current = await env.resolve(ref);
    if (!current) throw new Error("The conversation was not found any more");
    if (!current.turnRunning) return current;
    await env.stopTurn(current, owner);
    const until = Date.now() + options.stopWaitMs;
    do {
      await env.sleep(Math.min(options.pollMs, 1_000));
      const after = await env.resolve(ref);
      if (after && !after.turnRunning) return after;
    } while (Date.now() < until);
  }
  throw new Error("The running turn did not stop, so it stays where it is");
}

/** What the ownership transfer says when the conversation's owner is still in a turn, which a machine far away may not have heard of yet. */
const OWNER_BUSY = /Wait for the current (turn|queue dispatch) to finish/;

async function runEntry(env: MoveEnvironment, job: MoveJob, entry: MoveEntryState, conversation: MoveConversation, target: MoveNode, nodes: MoveNode[], gate: ReturnType<typeof limiter>, options: Required<MoveRunOptions>): Promise<void> {
  const set = (status: MoveStatus, detail: string | null = null) => { entry.status = status; entry.detail = detail; };
  const ref = { projectId: conversation.projectId, conversationId: conversation.conversationId };
  const deadline = Date.now() + options.waitLimitMs;
  const waitsForTurn = job.mode === "after-turn";

  /** One try at the move, with the stopping it needs. "busy": the owner is in a turn this machine did not know about. */
  async function attempt(current: MoveConversation, ownerIsBusy: boolean): Promise<"finished" | "busy"> {
    if (job.cancelled) throw new Stopped("Cancelled before it moved");
    const owner = nodes.find((node) => node.id === current.ownerNodeId) ?? null;
    if (!waitsForTurn && (current.turnRunning || ownerIsBusy)) {
      set("stopping", "Stopping the running turn");
      if (current.turnRunning) current = await stopRunningTurn(env, ref, owner, options);
      else await env.stopTurn(current, owner);
      entry.stopped = true;
    }
    if (current.ownerNodeId === target.id) { set("there", `Already on ${target.name}`); return "finished"; }
    set("moving", `Moving to ${target.name}`);
    try { await env.takeOwnership(current, target); }
    catch (error) {
      if (error instanceof Error && OWNER_BUSY.test(error.message)) return "busy";
      throw error;
    }
    if (!entry.stopped) { set("moved", `Moved to ${target.name}`); return "finished"; }
    set("continuing", "Telling it to continue");
    try {
      await env.sendMessage(current, target, continueMessage(entry.fromName ?? "its old machine", target.name));
      entry.continued = true;
      set("moved", `Moved to ${target.name} and told to continue`);
    } catch (error) {
      // Sent at most once: when the delivery is uncertain the person is told, and the message is not sent again.
      entry.continued = false;
      set("moved", `Moved to ${target.name}, but the continue message may not have arrived (${error instanceof Error ? error.message : String(error)}). Open it and check what was half done.`);
    }
    return "finished";
  }

  try {
    let ownerIsBusy = false;
    for (let tries = 1; ; tries += 1) {
      // Read it again: a turn may have ended, or the conversation may have moved, since the plan was made.
      let current = await env.resolve(ref);
      if (!current) throw new Error("The conversation was not found any more");
      if (current.turnRunning && waitsForTurn) {
        set("waiting", "Moves when its current turn ends");
        current = await waitForIdle(env, job, ref, options);
      }
      // Only the stopping and moving share a few places; waiting for a turn to end does not take one.
      if (await gate(() => attempt(current!, ownerIsBusy)) === "finished") return;
      if (waitsForTurn) {
        if (Date.now() > deadline) throw new Error(`Its turn did not end within ${Math.round(options.waitLimitMs / 3_600_000)} hours, so it stays where it is`);
        set("waiting", "Moves when its current turn ends");
        await env.sleep(options.pollMs);
      } else if (tries >= options.stopAttempts) throw new Error("The running turn did not stop, so it stays where it is");
      ownerIsBusy = true;
    }
  } catch (error) {
    if (error instanceof Stopped) set("cancelled", error.message);
    else set("failed", error instanceof Error ? error.message : String(error));
  } finally {
    busy.delete(keyOf(ref));
  }
}

export interface StartedMoves { job: MoveJob; done: Promise<void> }

/**
 * Starts the batch and returns at once with its state; the state changes as each conversation is handled and `done`
 * settles when all are finished. Conversations the plan marks as cannot move or already there are reported, not touched.
 */
export function startMoveJob(env: MoveEnvironment, accountId: string, plan: MovePlan, mode: MoveMode, runOptions: MoveRunOptions = {}): StartedMoves {
  const options = { ...DEFAULTS, ...runOptions };
  for (const [id, old] of jobs) if (old.finishedAt && Date.now() - Date.parse(old.finishedAt) > RETAIN_MS) jobs.delete(id);
  const job: MoveJob = { id: randomUUID(), accountId, mode, targetId: plan.target.id, targetName: plan.target.name, startedAt: new Date().toISOString(), finishedAt: null, cancelled: false, entries: [] };
  const gate = limiter(options.concurrency);
  const work: Promise<void>[] = [];
  for (const planned of plan.entries) {
    const entry: MoveEntryState = { projectId: planned.ref.projectId, conversationId: planned.ref.conversationId, title: planned.title, projectName: planned.projectName, fromName: planned.fromName, status: "moving", detail: null, stopped: false, continued: null };
    job.entries.push(entry);
    if (planned.verdict === "cannot") { entry.status = "cannot"; entry.detail = planned.reasons.join("; "); continue; }
    if (planned.verdict === "there") { entry.status = "there"; entry.detail = planned.reasons.join("; "); continue; }
    if (busy.has(keyOf(planned.ref))) { entry.status = "cannot"; entry.detail = "It is already being moved"; continue; }
    busy.add(keyOf(planned.ref));
    work.push(runEntry(env, job, entry, planned.conversation!, plan.target, plan.nodes, gate, options));
  }
  jobs.set(job.id, job);
  const done = Promise.all(work).then(() => { job.finishedAt = new Date().toISOString(); });
  if (!work.length) job.finishedAt = new Date().toISOString();
  return { job, done };
}

export function getMoveJob(accountId: string, id: string): MoveJob | undefined {
  const job = jobs.get(id);
  return job?.accountId === accountId ? job : undefined;
}

export function listMoveJobs(accountId: string): MoveJob[] {
  return [...jobs.values()].filter((job) => job.accountId === accountId).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Stops conversations still waiting for a turn to end from moving. Those already moving finish their move. */
export function cancelMoveJob(accountId: string, id: string): MoveJob | undefined {
  const job = getMoveJob(accountId, id);
  if (job) job.cancelled = true;
  return job;
}

/** What the person is told when a batch is over: counts first, then each conversation that did not move and why. */
export function summarizeMoveJob(job: MoveJob): { text: string; allMoved: boolean } {
  const moved = job.entries.filter((entry) => entry.status === "moved");
  const there = job.entries.filter((entry) => entry.status === "there");
  const rest = job.entries.filter((entry) => !["moved", "there"].includes(entry.status));
  const lines = [`Moved ${moved.length} of ${job.entries.length} to ${job.targetName}${there.length ? ` (${there.length} already there)` : ""}.`];
  for (const entry of moved.filter((candidate) => candidate.continued === false)) lines.push(`- ${entry.title}: ${entry.detail}`);
  for (const entry of rest) lines.push(`- ${entry.title}: ${entry.status === "cannot" ? "can't move" : entry.status === "cancelled" ? "not moved" : "failed"}. ${entry.detail ?? ""}`.trim());
  return { text: lines.join("\n"), allMoved: rest.length === 0 && moved.every((entry) => entry.continued !== false) };
}

// ── What Bob says ──────────────────────────────────────────────────────────────────────────────────────────

export const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

function describe(entry: MovePlanEntry): string {
  const where = entry.projectName ? ` (${entry.projectName})` : "";
  if (entry.verdict === "cannot") return `- ${entry.title}${where}: can't move. ${entry.reasons.join("; ")}`;
  if (entry.verdict === "there") return `- ${entry.title}${where}: already there`;
  return `- ${entry.title}${where}: ${entry.turnRunning ? "moves when its current turn ends" : "is not running a turn, so it moves at once"}`;
}

/** What Bob says before anything moves: what can move, what cannot and why, and what each button does. */
export function proposalText(plan: MovePlan, fromLabel: string): { text: string; movable: MovePlanEntry[] } {
  const movable = plan.entries.filter((entry) => entry.verdict === "ready");
  const stuck = plan.entries.filter((entry) => entry.verdict === "cannot");
  const there = plan.entries.filter((entry) => entry.verdict === "there");
  if (!movable.length) {
    const why = stuck.length ? `\n${stuck.map(describe).join("\n")}` : "";
    return { text: `Nothing can move to ${plan.target.name}${there.length ? ` (${plural(there.length, "conversation")} already there)` : ""}.${why}`, movable };
  }
  const lines = [`Move ${plural(movable.length, "job")} from ${fromLabel} to ${plan.target.name}?`, ...movable.map(describe)];
  if (stuck.length) lines.push("", "Can't move:", ...stuck.map(describe));
  if (there.length) lines.push("", `${plural(there.length, "conversation")} already on ${plan.target.name}.`);
  lines.push("", `"Move ${movable.length}" lets each running turn finish first. "Stop and move all now" stops the running turns, moves them, then tells each to continue and check what was half done before repeating anything.`);
  return { text: lines.join("\n"), movable };
}
