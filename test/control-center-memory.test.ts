import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { SystemOneChoice, SystemOneQuestion } from "../src/classifiers/typesafe.js";
import type { BobTurn } from "../src/control-center/bob-hooks.js";
import { appendBobMessage, DEFAULT_BOB_SETTINGS, ensureBobSchema, listBobMessages, writeBobSettings } from "../src/control-center/bob-store.js";
import { learnFromExchange, memoryText, parseAnswer, pickTopics, topicQuestions, useMemory, type MemoryDeps } from "../src/control-center/memory.js";
import { cleanTopic, ensureMemorySchema, lastRead, listChanges, listTopics, readTopic, writeTopic, type MemoryContext } from "../src/control-center/memory-store.js";
import { z } from "zod";

const YOU = { author: "person", why: "You created this topic", source: { kind: "person", text: "", messageId: null, conversationId: null, projectId: null, projectName: null } } as const;

async function setup(): Promise<{ ctx: MemoryContext; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-memory-logic-"));
  const db = new DatabaseSync(":memory:");
  ensureBobSchema(db);
  ensureMemorySchema(db);
  const ctx = { db, accountId: "ilia", root };
  for (const [name, description, body, project] of [
    ["how-ilia-works", "Plans before building, approves plans himself", "Plans first. See [[release-gate]].", null],
    ["release-gate", "Pushes need the iliagerman token; the first push is blocked once", "Push with the token. The release gate blocks the first push once.", "jb"],
    ["dak-live-slices", "Slice 7 is Ilia's, Slice 8 is Matan's", "Investigations are read-only.", "dak"],
  ] as const) writeTopic(ctx, cleanTopic(name, { description, body, project }), YOU);
  return { ctx, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function turn(message: string, over: Partial<BobTurn> = {}): BobTurn {
  return {
    session: { accountId: "ilia" } as never, message, recentChat: ["what is running?", "Two things."], project: { id: "jb", name: "Joint Bob" },
    options: [{ id: "jb", name: "Joint Bob", headlines: [] }, { id: "dak", name: "DAK Live", headlines: [] }],
    settings: { ...DEFAULT_BOB_SETTINGS }, ...over,
  };
}

interface Calls { asked: Array<{ state: string; questions: Record<string, SystemOneQuestion> }>; agent: Array<{ instructions: string; material: string }> }

/** A decision model that answers each topic question from `answers` (topic name to yes/no and confidence), and an agent that replies with `agentAnswer`. */
function fakeDeps(options: { answers?: Record<string, [string, number]> | null; learn?: [string, number]; agentAnswer?: string | (() => string); noAgent?: boolean; stateCharacters?: number } = {}): { deps: MemoryDeps; calls: Calls } {
  const calls: Calls = { asked: [], agent: [] };
  return {
    calls,
    deps: {
      stateCharacters: options.stateCharacters ?? 120_000,
      async ask(state, questions) {
        calls.asked.push({ state, questions });
        if (questions.learn) return options.learn ? { learn: { choice: options.learn[0], confidence: options.learn[1] } } : null;
        if (options.answers === null || options.answers === undefined) return null;
        const result: Record<string, SystemOneChoice> = {};
        for (const [key, question] of Object.entries(questions)) {
          const name = /"([a-z0-9-]+)"/.exec(question.instructions)![1];
          const [choice, confidence] = options.answers[name] ?? ["no", 0.99];
          result[key] = { choice, confidence };
        }
        return result;
      },
      ...options.noAgent ? {} : { async agent(step) { calls.agent.push(step); const answer = options.agentAnswer ?? "[]"; return typeof answer === "function" ? answer() : answer; } },
    },
  };
}

test("one batched request asks a yes or no question per topic, within the decision model's budget and a cap", async (t) => {
  const { ctx, cleanup } = await setup();
  t.after(cleanup);
  const topics = listTopics(ctx.root);
  const all = topicQuestions(turn("how do I push release 2.3?"), topics, 120_000);
  assert.equal(Object.keys(all.questions).length, 3, "every topic is asked in the same request");
  assert.deepEqual([...all.names.values()].sort(), ["dak-live-slices", "how-ilia-works", "release-gate"]);
  for (const question of Object.values(all.questions)) assert.deepEqual(Object.keys(question.criteria), ["yes", "no"]);
  assert.equal(JSON.parse(all.state).project, "Joint Bob");

  const small = topicQuestions(turn("how do I push release 2.3?"), topics, 700);
  assert.ok(Object.keys(small.questions).length < 3, "a model that reads less is asked about fewer topics");
  const used = small.state.length + Object.values(small.questions).reduce((sum, question) => sum + JSON.stringify(question).length, 0);
  assert.ok(used <= 700, `the request fits ${used}`);

  const many = Array.from({ length: 50 }, (_, index) => ({ ...topics[0], name: `topic-${index}`, description: `Subject ${index}` }));
  assert.equal(Object.keys(topicQuestions(turn("x"), many, 120_000).questions).length, 30, "capped to a sensible number");
});

test("the decision model's yes opens a topic; the list of every topic comes with it and a note says what was read", async (t) => {
  const { ctx, cleanup } = await setup();
  t.after(cleanup);
  const { deps, calls } = fakeDeps({ answers: { "release-gate": ["yes", 0.96] } });
  const contribution = await useMemory(ctx, turn("how do I push the release?"), async () => deps);
  assert.equal(calls.asked.length, 1, "one request for every topic");
  assert.equal(calls.agent.length, 0, "no agent was needed");
  assert.equal(contribution!.via, "Read memory: release-gate");
  assert.match(contribution!.text, /- how-ilia-works: Plans before building/);
  assert.match(contribution!.text, /- release-gate \(Joint Bob\): Pushes need the iliagerman token/);
  assert.match(contribution!.text, /- dak-live-slices \(DAK Live\): Slice 7/);
  assert.match(contribution!.text, /### release-gate\nPush with the token/);
  assert.doesNotMatch(contribution!.text, /### dak-live-slices|Investigations are read-only/);
  assert.deepEqual(lastRead(ctx)!.topics, ["release-gate"], "the memory tab can show what Bob read for the last message");
  assert.equal(lastRead(ctx)!.message, "how do I push the release?");
});

test("a topic the decision model is not sure about, under Bob's threshold, goes to a small agent step", async (t) => {
  const { ctx, cleanup } = await setup();
  t.after(cleanup);
  const { deps, calls } = fakeDeps({ answers: { "release-gate": ["yes", 0.95], "how-ilia-works": ["yes", 0.6] }, agentAnswer: 'Here you go: ["how-ilia-works", "made-up-topic"]' });
  const contribution = await useMemory(ctx, turn("push the release, plan it first"), async () => deps);
  assert.equal(calls.agent.length, 1);
  assert.match(calls.agent[0].material, /- how-ilia-works:/);
  assert.doesNotMatch(calls.agent[0].material, /release-gate:|dak-live-slices:/, "only the uncertain topics reach the agent");
  assert.equal(contribution!.via, "Read memory: release-gate, how-ilia-works (Bob's agent picked)");
  assert.match(contribution!.text, /### how-ilia-works\nPlans first/);
  assert.doesNotMatch(contribution!.text, /made-up-topic/, "a name the agent invents is ignored");
});

test("without a decision model the agent picks from the list; if that fails, Bob still gets the list", async (t) => {
  const { ctx, cleanup } = await setup();
  t.after(cleanup);
  const withAgent = fakeDeps({ answers: null, agentAnswer: '["dak-live-slices"]' });
  const picked = await useMemory(ctx, turn("who has slice 7?"), async () => withAgent.deps);
  for (const name of ["how-ilia-works", "release-gate", "dak-live-slices"]) assert.match(withAgent.calls.agent[0].material, new RegExp(`- ${name}:`), "the agent sees the whole list");
  assert.equal(picked!.via, "Read memory: dak-live-slices (Bob's agent picked)");

  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const failing = fakeDeps({ answers: null, agentAnswer: () => { throw new Error("agent down"); } });
    const listOnly = await useMemory(ctx, turn("who has slice 7?"), async () => failing.deps);
    assert.equal(listOnly!.via, undefined);
    assert.match(listOnly!.text, /- dak-live-slices \(DAK Live\)/);
    assert.doesNotMatch(listOnly!.text, /Topics Bob read/);

    const garbled = fakeDeps({ answers: null, agentAnswer: "no idea" });
    assert.equal((await useMemory(ctx, turn("who has slice 7?"), async () => garbled.deps))!.via, undefined);

    const broken = await useMemory(ctx, turn("hello"), async () => { throw new Error("no projects"); });
    assert.match(broken!.text, /- release-gate/);
  } finally { console.warn = originalWarn; }
  assert.equal(warnings.length, 3, "each fallback is logged, not silent");

  const noAgent = fakeDeps({ answers: null, noAgent: true });
  const only = await useMemory(ctx, turn("who has slice 7?"), async () => noAgent.deps);
  assert.equal(only!.via, undefined);
  assert.match(only!.text, /- how-ilia-works/);
});

test("an empty memory adds nothing, and topic text is bounded", async (t) => {
  const { ctx, cleanup } = await setup();
  t.after(cleanup);
  const empty: MemoryContext = { ...ctx, root: path.join(ctx.root, "nothing-here") };
  assert.equal(await useMemory(empty, turn("hi"), async () => assert.fail("no topics, nothing to ask")), null);
  const long = { ...readTopic(ctx.root, "release-gate")!, body: "x".repeat(9_000) };
  const text = memoryText([long], [long], new Map());
  assert.match(text, /… \(cut\)/);
  assert.ok(text.length < 5_000);
});

test("the agent's JSON is pulled from its words and checked", () => {
  assert.deepEqual(parseAnswer('Sure: {"a":1} done', z.object({ a: z.number() }), "{"), { a: 1 });
  assert.throws(() => parseAnswer("nothing", z.array(z.string()), "["), /did not answer with JSON/);
  assert.throws(() => parseAnswer('{"a":"x"}', z.object({ a: z.number() }), "{"));
});

test("pickTopics only trusts answers at or above the threshold", async (t) => {
  const { ctx, cleanup } = await setup();
  t.after(cleanup);
  const { deps, calls } = fakeDeps({ answers: { "release-gate": ["yes", 0.8], "dak-live-slices": ["yes", 0.95] }, agentAnswer: '["release-gate"]' });
  const loose = await pickTopics(deps, listTopics(ctx.root), turn("x", { settings: { ...DEFAULT_BOB_SETTINGS, threshold: 0.75 } }));
  assert.deepEqual(loose, { names: ["dak-live-slices", "release-gate"], agent: false });
  assert.equal(calls.agent.length, 0);
  const strict = await pickTopics(deps, listTopics(ctx.root), turn("x"));
  assert.deepEqual(strict, { names: ["dak-live-slices", "release-gate"], agent: true });
});

// ── Learning ──

const LEARNED = JSON.stringify({ remember: true, topic: "automations-conventions", description: "Daily reports run on the homeserver at 07:00", body: "Daily reports run on the homeserver at 07:00.\nHourly checks look back one hour only.", project: "jb", why: "You set up the slow query report" });

test("an exchange the decision model calls nothing lasting never reaches the agent", async (t) => {
  const { ctx, cleanup } = await setup();
  t.after(cleanup);
  const { deps, calls } = fakeDeps({ learn: ["nothing", 0.97], agentAnswer: LEARNED });
  assert.equal(await learnFromExchange(ctx, deps, turn("thanks"), "You're welcome."), null);
  assert.equal(calls.agent.length, 0);
  assert.equal(calls.asked.length, 1);
});

test("a yes writes a topic, records the change with its source, and tells the person in Bob's chat", async (t) => {
  const { ctx, cleanup } = await setup();
  t.after(cleanup);
  appendBobMessage(ctx.db, "ilia", { role: "user", text: "daily reports run on the homeserver at 7" });
  const { deps, calls } = fakeDeps({ learn: ["preference", 0.95], agentAnswer: `Here is the note: ${LEARNED}` });
  const change = (await learnFromExchange(ctx, deps, turn("daily reports run on the homeserver at 7"), "Noted."))!;
  assert.equal(change.status, "applied");
  assert.equal(change.kind, "create");
  assert.equal(change.why, "You set up the slow query report");
  assert.equal(change.source.kind, "chat");
  assert.equal(change.source.text, "daily reports run on the homeserver at 7");
  assert.equal(change.source.projectName, "Joint Bob");
  assert.ok(change.source.messageId, "the chat message that taught it is recorded");
  assert.equal(readTopic(ctx.root, "automations-conventions")!.project, "jb");
  assert.match(calls.agent[0].material, /decision model judged this a preference/);
  assert.match(calls.agent[0].material, /## release-gate \(project jb\): Pushes need the iliagerman token/);

  const posted = listBobMessages(ctx.db, "ilia").at(-1)!;
  assert.equal(posted.importance, "fyi");
  assert.match(posted.text, /automations-conventions/);
  assert.deepEqual(posted.actions.map((action) => [action.id, action.data]), [["memory-revert", { changeId: change.id }]]);
});

test("with ask-before-saving the change waits: the topic is untouched and Bob asks with Keep and Revert", async (t) => {
  const { ctx, cleanup } = await setup();
  t.after(cleanup);
  writeBobSettings(ctx.db, "ilia", { askBeforeSaving: true });
  const { deps } = fakeDeps({ learn: ["preference", 0.95], agentAnswer: LEARNED });
  const change = (await learnFromExchange(ctx, deps, turn("daily reports run at 7"), "Noted."))!;
  assert.equal(change.status, "pending");
  assert.equal(readTopic(ctx.root, "automations-conventions"), null);
  assert.equal(existsSync(path.join(ctx.root, "automations-conventions.md")), false);
  const posted = listBobMessages(ctx.db, "ilia").at(-1)!;
  assert.equal(posted.importance, "needs-you");
  assert.deepEqual(posted.actions.map((action) => [action.id, action.label]), [["memory-keep", "Keep"], ["memory-revert", "Revert"]]);
  assert.match(posted.text, /Daily reports run on the homeserver at 07:00/);
});

test("below the confidence threshold or with no decision model the agent decides, and may find nothing", async (t) => {
  const { ctx, cleanup } = await setup();
  t.after(cleanup);
  const unsure = fakeDeps({ learn: ["nothing", 0.5], agentAnswer: '{"remember": false}' });
  assert.equal(await learnFromExchange(ctx, unsure.deps, turn("hmm"), "ok"), null);
  assert.equal(unsure.calls.agent.length, 1, "an unsure decision model does not stop the agent");
  assert.doesNotMatch(unsure.calls.agent[0].material, /decision model judged/);

  const none = fakeDeps({ agentAnswer: LEARNED });
  assert.ok(await learnFromExchange(ctx, none.deps, turn("daily reports run at 7"), "Noted."), "no decision model: the agent decides and writes");
});

test("an update shows the agent the existing text and keeps the person's project tag unless told otherwise", async (t) => {
  const { ctx, cleanup } = await setup();
  t.after(cleanup);
  const update = JSON.stringify({ remember: true, topic: "release-gate", description: "Pushes need the iliagerman token; the first push is blocked once", body: "Push with the token. The release gate blocks the first push once.\nNever force-push main.", why: "You said never force-push" });
  const { deps, calls } = fakeDeps({ learn: ["correction", 0.99], agentAnswer: update });
  const change = (await learnFromExchange(ctx, deps, turn("never force-push main"), "Understood."))!;
  assert.equal(change.kind, "update");
  assert.match(calls.agent[0].material, /Push with the token\. The release gate blocks/);
  assert.deepEqual(change.diff, [{ type: "add", text: "Never force-push main." }]);
  assert.equal(readTopic(ctx.root, "release-gate")!.project, "jb");
});

test("nothing is written when the agent answers badly, rewrites a topic it was not shown, or Bob is paused", async (t) => {
  const { ctx, cleanup } = await setup();
  t.after(cleanup);
  const before = listChanges(ctx, 0, 50).total;
  for (const bad of ["no json here", '{"remember": true, "topic": "Bad Name", "description": "d", "body": "b", "why": "w"}', '{"remember": true, "topic": "ok-topic", "description": "", "body": "b", "why": "w"}']) {
    await assert.rejects(learnFromExchange(ctx, fakeDeps({ learn: ["decision", 0.95], agentAnswer: bad }).deps, turn("x y z"), "ok"), bad);
  }
  assert.equal(listChanges(ctx, 0, 50).total, before);

  // Existing topics that do not fit in what the agent is shown are listed without text, and cannot be rewritten blind.
  writeTopic(ctx, cleanTopic("big-topic", { description: "Big", body: "z".repeat(15_000) }), YOU);
  writeTopic(ctx, cleanTopic("big-two", { description: "Big two", body: "w".repeat(15_000) }), YOU);
  const probe = fakeDeps({
    learn: ["decision", 0.95],
    agentAnswer: () => {
      const hidden = /## ([a-z0-9-]+)[^\n]*\n\(text not shown\)/.exec(probe.calls.agent.at(-1)!.material)![1];
      return JSON.stringify({ remember: true, topic: hidden, description: "d", body: "new", why: "w" });
    },
  });
  await assert.rejects(learnFromExchange(ctx, probe.deps, turn("q"), "a"), /without seeing its text/);

  writeBobSettings(ctx.db, "ilia", { monitoring: false });
  const paused = fakeDeps({ learn: ["decision", 0.99], agentAnswer: LEARNED });
  assert.equal(await learnFromExchange(ctx, paused.deps, turn("daily reports run at 7"), "ok"), null);
  assert.equal(paused.calls.asked.length, 0, "while Bob is paused nothing is asked or written on its own");
  assert.equal(await learnFromExchange(ctx, fakeDeps({ learn: ["decision", 0.99], noAgent: true }).deps, turn("x"), "y"), null, "without a project to run an agent in there is nothing to write with");
});
