import assert from "node:assert/strict";
import test from "node:test";
import type { AskChoices } from "../src/control-center/decisions.js";
import { agentIntentPrompt, decideMoveIntent, moveIntentSchema, parseAgentIntent, type IntentCard, type IntentInput } from "../src/control-center/moves-intent.js";
import {
  cancelMoveJob, continueMessage, getMoveJob, listMoveJobs, MoveError, planMoves, proposalText, startMoveJob, summarizeMoveJob,
  type MoveConversation, type MoveEnvironment, type MoveNode, type MoveRef,
} from "../src/control-center/moves.js";

const MAC: MoveNode = { id: "11111111-1111-4111-8111-111111111111", name: "Mac", local: true, online: true };
const HOME: MoveNode = { id: "22222222-2222-4222-8222-222222222222", name: "Homeserver", local: false, online: true };
const EC2: MoveNode = { id: "33333333-3333-4333-8333-333333333333", name: "Contigos EC2", local: false, online: false };
const NODES = [MAC, HOME, EC2];

function conversation(id: string, extra: Partial<MoveConversation> = {}): MoveConversation {
  return {
    projectId: "p1", conversationId: id, projectName: "Joint Bob", sessionId: id, path: `/${id}`, title: `Job ${id}`,
    harnessId: "claude", harnessLabel: "Claude", model: "Sonnet", ownerNodeId: MAC.id, turnRunning: false, fixedReason: null, ...extra,
  };
}

/** A fake cluster: conversations live in a map and every call the mover makes is recorded in order. */
function fake(initial: MoveConversation[], options: { blockers?: (conversation: MoveConversation, target: MoveNode) => string[]; onSleep?: (calls: number) => void; stopWorks?: boolean; takeError?: string; sendError?: string; realSleep?: boolean; ownerBusyFor?: number } = {}) {
  const world = new Map(initial.map((entry) => [entry.conversationId, { ...entry }]));
  const calls: string[] = [];
  const sent: Array<{ id: string; node: string; text: string }> = [];
  let sleeps = 0;
  let busyLeft = options.ownerBusyFor ?? 0;
  const env: MoveEnvironment = {
    nodes: async () => NODES,
    resolve: async (ref: MoveRef) => { const entry = world.get(ref.conversationId); return entry ? { ...entry } : null; },
    blockers: async (entry, target) => options.blockers?.(entry, target) ?? [],
    stopTurn: async (entry) => { calls.push(`stop ${entry.conversationId}`); if (options.stopWorks !== false) world.get(entry.conversationId)!.turnRunning = false; },
    takeOwnership: async (entry, target) => {
      calls.push(`take ${entry.conversationId} ${target.name}`);
      if (options.takeError) throw new Error(options.takeError);
      // The owner is in a turn this machine has not heard of yet.
      if (busyLeft > 0) { busyLeft -= 1; throw new Error("Queue transfer was not acknowledged by its owner: Wait for the current queue dispatch to finish before transferring"); }
      world.get(entry.conversationId)!.ownerNodeId = target.id;
    },
    sendMessage: async (entry, target, text) => {
      calls.push(`send ${entry.conversationId}`);
      sent.push({ id: entry.conversationId, node: target.name, text });
      if (options.sendError) throw new Error(options.sendError);
    },
    sleep: async () => { sleeps += 1; options.onSleep?.(sleeps); if (options.realSleep) await new Promise((resolve) => setTimeout(resolve, 5)); },
  };
  return { env, world, calls, sent };
}

const REFS = (...ids: string[]) => ids.map((id) => ({ projectId: "p1", conversationId: id }));
const FAST = { pollMs: 1, stopWaitMs: 5, waitLimitMs: 1_000 };

test("the plan says what moves, what is already there, and why something cannot move", async () => {
  const { env } = fake([
    conversation("idle"), conversation("running", { turnRunning: true }), conversation("there", { ownerNodeId: HOME.id }),
    conversation("ticket", { fixedReason: "It belongs to a ticket: move the ticket instead" }), conversation("pi", { harnessId: "pi" }),
  ], { blockers: (entry) => entry.harnessId === "pi" ? ["Pi is not signed in on this machine"] : [] });
  const plan = await planMoves(env, [...REFS("idle", "running", "there", "ticket", "pi", "missing", "idle")], HOME.id);
  assert.equal(plan.target.name, "Homeserver");
  assert.deepEqual(plan.entries.map((entry) => [entry.ref.conversationId, entry.verdict]), [
    ["idle", "ready"], ["running", "ready"], ["there", "there"], ["ticket", "cannot"], ["pi", "cannot"], ["missing", "cannot"],
  ], "a conversation named twice is planned once");
  assert.equal(plan.entries[1].turnRunning, true);
  assert.equal(plan.entries[0].fromName, "Mac");
  assert.deepEqual(plan.entries[4].reasons, ["Pi is not signed in on this machine"]);
  assert.deepEqual(plan.entries[5].reasons, ["The conversation was not found"]);
  await assert.rejects(planMoves(env, REFS("idle"), "44444444-4444-4444-8444-444444444444"), (error: unknown) => error instanceof MoveError && error.status === 404);
});

test("moving after the current turn waits for the turn, moves it, and sends nothing", async () => {
  const { env, world, calls, sent } = fake([conversation("idle"), conversation("busy", { turnRunning: true })], { onSleep: (count) => { if (count === 3) world.get("busy")!.turnRunning = false; } });
  const plan = await planMoves(env, REFS("idle", "busy"), HOME.id);
  const { job, done } = startMoveJob(env, "acct-1", plan, "after-turn", FAST);
  await done;
  assert.deepEqual(job.entries.map((entry) => [entry.title, entry.status]), [["Job idle", "moved"], ["Job busy", "moved"]]);
  assert.equal(world.get("busy")!.ownerNodeId, HOME.id);
  assert.deepEqual(calls.filter((call) => call.startsWith("stop") || call.startsWith("send")), [], "the running turn was left alone and nothing was sent");
  assert.ok(calls.indexOf("take idle Homeserver") < calls.indexOf("take busy Homeserver"), "the idle one did not wait for the busy one");
  assert.deepEqual(sent, []);
  assert.ok(job.finishedAt);
});

test("a waiting conversation shows that it waits, and cancelling leaves it where it is", async () => {
  const { env, world, calls } = fake([conversation("busy", { turnRunning: true })], { realSleep: true });
  const plan = await planMoves(env, REFS("busy"), HOME.id);
  const started = startMoveJob(env, "acct-cancel", plan, "after-turn", FAST);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.job.entries[0].status, "waiting");
  assert.equal(getMoveJob("acct-cancel", started.job.id), started.job);
  assert.equal(getMoveJob("someone-else", started.job.id), undefined, "another account cannot see it");
  cancelMoveJob("acct-cancel", started.job.id);
  await started.done;
  assert.equal(started.job.entries[0].status, "cancelled");
  assert.equal(world.get("busy")!.ownerNodeId, MAC.id);
  assert.deepEqual(calls, []);
  assert.equal(listMoveJobs("acct-cancel").length, 1);
});

test("stop and move now stops the turn, moves it, then sends the one continue message", async () => {
  const { env, world, calls, sent } = fake([conversation("busy", { turnRunning: true }), conversation("waiting")]);
  const plan = await planMoves(env, REFS("busy", "waiting"), HOME.id);
  const { job, done } = startMoveJob(env, "acct-now", plan, "now", FAST);
  await done;
  assert.deepEqual(calls.filter((call) => call.includes("busy")), ["stop busy", "take busy Homeserver", "send busy"], "stop, then move, then tell it to continue");
  assert.deepEqual(sent, [{ id: "busy", node: "Homeserver", text: "Continue where you stopped: you were moved from Mac to Homeserver. Check what was half done before repeating anything." }]);
  assert.equal(sent[0].text, continueMessage("Mac", "Homeserver"));
  assert.deepEqual(calls.filter((call) => call.includes("waiting")), ["take waiting Homeserver"], "a conversation that was waiting for the person is moved, not told to continue");
  assert.equal(world.get("busy")!.ownerNodeId, HOME.id);
  const busy = job.entries[0];
  assert.deepEqual([busy.status, busy.stopped, busy.continued], ["moved", true, true]);
  assert.deepEqual([job.entries[1].stopped, job.entries[1].continued], [false, null]);
});

test("a turn that ends before it is stopped is moved without a continue message", async () => {
  const { env, world, sent, calls } = fake([conversation("racing", { turnRunning: true })]);
  const plan = await planMoves(env, REFS("racing"), HOME.id);
  world.get("racing")!.turnRunning = false;
  const { job, done } = startMoveJob(env, "acct-race", plan, "now", FAST);
  await done;
  assert.equal(job.entries[0].status, "moved");
  assert.deepEqual([calls.includes("stop racing"), sent.length], [false, 0]);
});

test("a turn that will not stop is not moved and nothing is sent", async () => {
  const { env, world, calls, sent } = fake([conversation("stuck", { turnRunning: true })], { stopWorks: false });
  const plan = await planMoves(env, REFS("stuck"), HOME.id);
  const { job, done } = startMoveJob(env, "acct-stuck", plan, "now", { ...FAST, stopAttempts: 2 });
  await done;
  assert.equal(job.entries[0].status, "failed");
  assert.match(job.entries[0].detail!, /did not stop/);
  assert.equal(world.get("stuck")!.ownerNodeId, MAC.id);
  assert.deepEqual(calls, ["stop stuck", "stop stuck"], "it was asked to stop twice and never moved");
  assert.deepEqual(sent, []);
});

test("a refused transfer is reported with its reason and nothing is sent to the conversation", async () => {
  const { env, sent } = fake([conversation("busy", { turnRunning: true })], { takeError: "Wait for the conversation transcript to synchronize to this node before taking ownership" });
  const plan = await planMoves(env, REFS("busy"), HOME.id);
  const { job, done } = startMoveJob(env, "acct-refused", plan, "now", FAST);
  await done;
  assert.equal(job.entries[0].status, "failed");
  assert.match(job.entries[0].detail!, /synchronize/);
  assert.deepEqual(sent, []);
});

test("the continue message is never sent twice, even when its delivery fails", async () => {
  const { env, calls, sent } = fake([conversation("busy", { turnRunning: true })], { sendError: "the conversation did not queue it in time" });
  const plan = await planMoves(env, REFS("busy"), HOME.id);
  const { job, done } = startMoveJob(env, "acct-send", plan, "now", FAST);
  await done;
  const entry = job.entries[0];
  assert.deepEqual([entry.status, entry.continued], ["moved", false]);
  assert.match(entry.detail!, /may not have arrived/);
  assert.equal(sent.length, 1);
  assert.equal(calls.filter((call) => call === "send busy").length, 1);
  const summary = summarizeMoveJob(job);
  assert.equal(summary.allMoved, false, "the person is told to look at it");
  assert.match(summary.text, /Job busy: Moved to Homeserver, but the continue message may not have arrived/);
});

test("an owner that says it is still in a turn is waited for after the turn, and stopped for now", async () => {
  const waiting = fake([conversation("far")], { ownerBusyFor: 2, realSleep: true });
  const afterTurn = startMoveJob(waiting.env, "acct-busy-1", await planMoves(waiting.env, REFS("far"), HOME.id), "after-turn", FAST);
  await afterTurn.done;
  assert.equal(afterTurn.job.entries[0].status, "moved", "it was not reported as failed");
  assert.deepEqual(waiting.calls, ["take far Homeserver", "take far Homeserver", "take far Homeserver"]);
  assert.deepEqual(waiting.sent, []);

  const stopping = fake([conversation("far")], { ownerBusyFor: 1 });
  const now = startMoveJob(stopping.env, "acct-busy-2", await planMoves(stopping.env, REFS("far"), HOME.id), "now", FAST);
  await now.done;
  assert.deepEqual(now.job.entries[0].status, "moved");
  assert.deepEqual(stopping.calls, ["take far Homeserver", "stop far", "take far Homeserver", "send far"], "it was stopped when the owner said it was busy, then moved and told to continue");
  assert.equal(stopping.sent.length, 1);

  const stuck = fake([conversation("far")], { ownerBusyFor: 99 });
  const never = startMoveJob(stuck.env, "acct-busy-3", await planMoves(stuck.env, REFS("far"), HOME.id), "now", { ...FAST, stopAttempts: 2 });
  await never.done;
  assert.equal(never.job.entries[0].status, "failed");
  assert.match(never.job.entries[0].detail!, /did not stop/);
  assert.deepEqual(stuck.sent, []);
});

test("the same conversation is never moved by two batches at once", async () => {
  const { env, world } = fake([conversation("busy", { turnRunning: true })], { realSleep: true });
  const plan = await planMoves(env, REFS("busy"), HOME.id);
  const first = startMoveJob(env, "acct-twice", plan, "after-turn", FAST);
  const second = startMoveJob(env, "acct-twice", plan, "after-turn", FAST);
  assert.deepEqual([second.job.entries[0].status, second.job.entries[0].detail], ["cannot", "It is already being moved"]);
  world.get("busy")!.turnRunning = false;
  await first.done;
  assert.equal(first.job.entries[0].status, "moved");
});

test("waiting gives up after the limit and leaves the conversation where it is", async () => {
  const { env, world } = fake([conversation("endless", { turnRunning: true })], { realSleep: true });
  const plan = await planMoves(env, REFS("endless"), HOME.id);
  const { job, done } = startMoveJob(env, "acct-limit", plan, "after-turn", { pollMs: 1, waitLimitMs: 5 });
  await done;
  assert.equal(job.entries[0].status, "failed");
  assert.match(job.entries[0].detail!, /did not end/);
  assert.equal(world.get("endless")!.ownerNodeId, MAC.id);
});

test("only a few conversations are stopped and moved at the same time", async () => {
  let active = 0;
  let peak = 0;
  const { env } = fake(Array.from({ length: 8 }, (_, index) => conversation(`c${index}`)));
  const take = env.takeOwnership;
  env.takeOwnership = async (entry, target) => { active += 1; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 5)); await take(entry, target); active -= 1; };
  const plan = await planMoves(env, REFS(...Array.from({ length: 8 }, (_, index) => `c${index}`)), HOME.id);
  const { job, done } = startMoveJob(env, "acct-gate", plan, "after-turn", { ...FAST, concurrency: 3 });
  await done;
  assert.equal(job.entries.every((entry) => entry.status === "moved"), true);
  assert.equal(peak, 3);
});

test("a batch with nothing to do is finished at once and says why for each", async () => {
  const { env } = fake([conversation("there", { ownerNodeId: HOME.id }), conversation("ro", { fixedReason: "Its transcript is read-only" })]);
  const plan = await planMoves(env, REFS("there", "ro"), HOME.id);
  const { job, done } = startMoveJob(env, "acct-empty", plan, "now", FAST);
  await done;
  assert.ok(job.finishedAt);
  assert.deepEqual(job.entries.map((entry) => [entry.status, entry.detail]), [["there", "Already on Homeserver"], ["cannot", "Its transcript is read-only"]]);
  assert.match(summarizeMoveJob(job).text, /Moved 0 of 2 to Homeserver \(1 already there\)\.\n- Job ro: can't move\. Its transcript is read-only/);
});

test("Bob's proposal lists what moves, what cannot and why, and says what each button does", async () => {
  const { env } = fake([conversation("a", { turnRunning: true }), conversation("b"), conversation("c", { harnessId: "pi" })], { blockers: (entry) => entry.harnessId === "pi" ? ["Pi on Bedrock is not set up on this machine"] : [] });
  const plan = await planMoves(env, REFS("a", "b", "c"), HOME.id);
  const { text, movable } = proposalText(plan, "Mac");
  assert.equal(movable.length, 2);
  assert.match(text, /^Move 2 jobs from Mac to Homeserver\?/);
  assert.match(text, /- Job a \(Joint Bob\): moves when its current turn ends/);
  assert.match(text, /- Job b \(Joint Bob\): is not running a turn, so it moves at once/);
  assert.match(text, /Can't move:\n- Job c \(Joint Bob\): can't move\. Pi on Bedrock is not set up on this machine/);
  assert.match(text, /"Stop and move all now" stops the running turns, moves them, then tells each to continue and check what was half done/);
  const none = proposalText(await planMoves(env, REFS("c"), HOME.id), "Mac");
  assert.match(none.text, /^Nothing can move to Homeserver\./);
  assert.equal(none.movable.length, 0);
});

// ── Reading the request ─────────────────────────────────────────────────────────────────────────────────

const CARDS: IntentCard[] = [
  { projectId: "p1", conversationId: "slice7", title: "Slice 7 explore map", projectName: "DAK Live" },
  { projectId: "p1", conversationId: "billing", title: "Community Plus billing", projectName: "Contigos" },
];

function intentInput(ask: AskChoices | null, extra: Partial<IntentInput> = {}): IntentInput {
  return { message: "move all my running jobs from the mac to the homeserver", recentChat: [], nodes: [MAC, HOME], cards: CARDS, ask, askAgent: null, threshold: 0.9, stateCharacters: 4_000, ...extra };
}

const sure = (choice: string, confidence = 0.96) => ({ choice, confidence });

test("the decision model's answers become a validated move request", async () => {
  const asked: Array<{ state: string; questions: string[] }> = [];
  const ask: AskChoices = async (state, questions) => {
    asked.push({ state, questions: Object.keys(questions) });
    return { moves: sure("move"), target: sure("node_1"), from: sure("node_0"), which: sure("all") };
  };
  const result = await decideMoveIntent(intentInput(ask));
  assert.deepEqual(result, { kind: "move", intent: { target: HOME.id, from: MAC.id, conversation: null }, confidence: 0.96, by: "decision model" });
  assert.equal(asked.length, 1, "everything is asked in one request");
  assert.deepEqual(asked[0].questions, ["moves", "target", "from", "which"]);
  assert.match(asked[0].state, /Homeserver/);
});

test("one conversation can be named, and a named source implies the other machine when there are two", async () => {
  const ask: AskChoices = async () => ({ moves: sure("move"), target: sure("none"), from: sure("node_0"), which: sure("card_1") });
  const result = await decideMoveIntent(intentInput(ask));
  assert.equal(result.kind, "move");
  if (result.kind === "move") assert.deepEqual(result.intent, { target: HOME.id, from: MAC.id, conversation: { projectId: "p1", conversationId: "billing" } });
  const three = await decideMoveIntent(intentInput(ask, { nodes: NODES }));
  assert.equal(three.kind, "unclear", "with three machines a missing destination is asked about, not guessed");
});

test("a message that is not about moving passes through, and a low-confidence one goes to Bob's agent", async () => {
  assert.equal((await decideMoveIntent(intentInput(async () => ({ moves: sure("other"), target: sure("none"), from: sure("any"), which: sure("all") })))).kind, "other");
  const prompts: string[] = [];
  const unsure: AskChoices = async () => ({ moves: sure("move", 0.7), target: sure("node_1"), from: sure("node_0"), which: sure("all") });
  const agent = await decideMoveIntent(intentInput(unsure, { askAgent: async (prompt) => { prompts.push(prompt); return 'Sure: {"move": true, "target": "homeserver", "from": "MAC", "conversation": "community plus billing"}'; } }));
  assert.deepEqual(agent, { kind: "move", intent: { target: HOME.id, from: MAC.id, conversation: { projectId: "p1", conversationId: "billing" } }, confidence: 1, by: "Bob's agent" });
  assert.match(prompts[0], /Machines: Mac, Homeserver/);
  assert.match(prompts[0], /Message: move all my running jobs/);
  const noModel = await decideMoveIntent(intentInput(null, { askAgent: async () => '{"move": false}' }));
  assert.deepEqual(noModel, { kind: "other", confidence: 1, by: "Bob's agent" });
});

test("Bob's agent reads only what could be about moving", async () => {
  const asked: string[] = [];
  const agent = async (prompt: string) => { asked.push(prompt); return '{"move": false}'; };
  assert.equal((await decideMoveIntent(intentInput(null, { message: "what is the status of the billing work?", askAgent: agent }))).kind, "other");
  assert.deepEqual(asked, [], "no decision model and nothing about moving: the agent is not run for it");
  await decideMoveIntent(intentInput(null, { message: "get everything onto the homeserver", askAgent: agent }));
  await decideMoveIntent(intentInput(null, { message: "please move the billing job", askAgent: agent }));
  assert.equal(asked.length, 2, "a machine's name, or a word for moving, is enough to ask");
  const unsure: AskChoices = async () => ({ moves: sure("move", 0.6), target: sure("node_1"), from: sure("any"), which: sure("all") });
  await decideMoveIntent(intentInput(unsure, { message: "ship it over", askAgent: agent }));
  assert.equal(asked.length, 3, "a decision model that thought it was a move but was unsure is checked by the agent");
});

test("what the agent says is checked: unknown machines and junk are not a request", async () => {
  assert.equal(parseAgentIntent("no idea", { nodes: [MAC, HOME], cards: CARDS }), null);
  assert.equal(parseAgentIntent('{"move": "yes"}', { nodes: [MAC, HOME], cards: CARDS }), null);
  assert.equal(parseAgentIntent('{"move": true, "target": "the cloud"}', { nodes: [MAC, HOME], cards: CARDS })?.kind, "unclear");
  assert.equal(parseAgentIntent('{"move": true, "target": "Mac", "from": "Mac"}', { nodes: [MAC, HOME], cards: CARDS }), null, "from a machine to itself is refused");
  assert.equal(moveIntentSchema.safeParse({ target: "mac", from: null, conversation: null }).success, false);
  const fallback = await decideMoveIntent(intentInput(null, { askAgent: async () => "garbled" }));
  assert.equal(fallback.kind, "other", "an unreadable answer leaves the message to Bob's usual path");
  assert.match(agentIntentPrompt({ message: "x", recentChat: ["hello"], nodes: [MAC], cards: [] }), /Unfinished conversations: none[\s\S]*Recent chat: hello/);
});

test("the request fits a small decision model: the conversation list is capped and long messages are cut", async () => {
  let seen: { state: string; questions: Record<string, { criteria: Record<string, string> }> } | undefined;
  const many = Array.from({ length: 40 }, (_, index) => ({ projectId: "p1", conversationId: `c${index}`, title: `Conversation number ${index} with a rather long descriptive title that goes on and on`, projectName: "P" }));
  await decideMoveIntent(intentInput(async (state, questions) => { seen = { state, questions }; return null; }, { cards: many, message: "move ".repeat(2_000), recentChat: ["x".repeat(2_000)], stateCharacters: 2_500 }));
  assert.ok(seen);
  assert.ok(seen.state.length <= 2_500);
  assert.equal(Object.keys(seen.questions.which.criteria).length, 13, "all plus twelve named conversations");
});
