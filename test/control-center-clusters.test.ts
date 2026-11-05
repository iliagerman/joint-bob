import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_BOB_SETTINGS } from "../src/control-center/bob-store.js";
import type { BobTurn } from "../src/control-center/bob-hooks.js";
import { messageIsAboutPeople, useClusters } from "../src/control-center/clusters-bob.js";
import {
  buildClusterView, clusterAgentsText, EMPTY_CLUSTER_VIEW, namesPeople, personWords,
  type ClusterInfo, type ClusterView, type ClusterViewInput, type SharedConversation,
} from "../src/control-center/clusters.js";

// Fabricated peers: this person (Ilia, on "ilia-mac"), a twin of theirs, and two teammates in the cluster "Sela team".
const ME = "00000000-0000-4000-8000-00000000000a";
const TWIN = "00000000-0000-4000-8000-00000000000b";
const MATAN = "00000000-0000-4000-8000-00000000000c";
const IDO = "00000000-0000-4000-8000-00000000000d";
const STRANGER = "00000000-0000-4000-8000-00000000000e";
const SELA = "11111111-1111-4111-8111-111111111111";
const FAMILY = "22222222-2222-4222-8222-222222222222";

const sela: ClusterInfo = { id: SELA, name: "Sela team", relay: false, members: [
  { nodeId: ME, name: "Ilia's Mac" }, { nodeId: TWIN, name: "Homeserver" }, { nodeId: MATAN, name: "Matan's Mac" }, { nodeId: IDO, name: "Ido's Laptop" },
] };
const family: ClusterInfo = { id: FAMILY, name: "Family", relay: false, members: [{ nodeId: ME, name: "Ilia's Mac" }, { nodeId: IDO, name: "Ido's Laptop" }] };

function conversation(overrides: Partial<SharedConversation> & { sessionId: string; executionNodeId: string | null }): SharedConversation {
  return {
    projectId: "dak", projectName: "DAK Live", projectClusterIds: [SELA], conversationId: overrides.sessionId, path: `/p/${overrides.sessionId}`, title: overrides.sessionId,
    agentLabel: "Claude", agentModel: null, turnRunning: true, backgroundRunning: false, updatedAt: "2026-11-05T10:00:00Z", summary: null, ...overrides,
  };
}

function input(overrides: Partial<ClusterViewInput> = {}): ClusterViewInput {
  return {
    localNodeId: ME, twinNodeIds: new Set([TWIN]), blockedNodeIds: new Set(), awayNodeIds: new Set(), clusters: [sela, family], conversations: [], ...overrides,
  };
}

test("agents are grouped by the machine of the person who runs them, with what each shares", () => {
  const view = buildClusterView(input({ conversations: [
    conversation({ sessionId: "slice-8", title: "Slice 8 — creator payouts", executionNodeId: MATAN, agentModel: "opus", summary: "Writing the payout job", updatedAt: "2026-11-05T10:05:00Z" }),
    conversation({ sessionId: "billing", title: "Community Plus billing", executionNodeId: MATAN, updatedAt: "2026-11-05T10:09:00Z" }),
    conversation({ sessionId: "table", title: "Design studio table", projectId: "kms", projectName: "KMS trunk", executionNodeId: IDO, turnRunning: false, backgroundRunning: true, projectClusterIds: [SELA, FAMILY] }),
  ] }));
  assert.deepEqual(view.machines.map((machine) => [machine.name, machine.agents.map((agent) => agent.title)]), [
    ["Matan's Mac", ["Community Plus billing", "Slice 8 — creator payouts"]],
    ["Ido's Laptop", ["Design studio table"]],
  ]);
  const [slice] = view.machines[0].agents.slice(1);
  assert.deepEqual({ model: slice.agentModel, summary: slice.summary, state: slice.state, nodeId: slice.nodeId }, { model: "opus", summary: "Writing the payout job", state: "running", nodeId: MATAN });
  const table = view.machines[1].agents[0];
  assert.equal(table.state, "background");
  assert.deepEqual(table.clusterIds, [FAMILY, SELA].sort(), "an agent is shared through every cluster that holds both its machine and its project");
  assert.deepEqual(view.clusters, [
    { id: SELA, name: "Sela team", relay: false, machines: 2, running: 3 },
    { id: FAMILY, name: "Family", relay: false, machines: 1, running: 1 },
  ]);
  assert.deepEqual(view.projects, [{ id: "dak", name: "DAK Live" }, { id: "kms", name: "KMS trunk" }]);
});

test("the person's own machine, their twin, a blocked machine and one in none of their clusters never show", () => {
  const view = buildClusterView(input({
    blockedNodeIds: new Set([IDO]),
    conversations: [
      conversation({ sessionId: "mine", executionNodeId: ME }),
      conversation({ sessionId: "twins", executionNodeId: TWIN }),
      conversation({ sessionId: "blocked", executionNodeId: IDO }),
      conversation({ sessionId: "stranger", executionNodeId: STRANGER }),
      conversation({ sessionId: "unowned", executionNodeId: null }),
      conversation({ sessionId: "teammates", executionNodeId: MATAN }),
    ],
  }));
  assert.deepEqual(view.machines.flatMap((machine) => machine.agents.map((agent) => agent.sessionId)), ["teammates"]);
  assert.deepEqual(view.machines.map((machine) => machine.name), ["Matan's Mac"], "a blocked machine is not listed as a person's machine either");
});

test("a conversation is shown only through a cluster that holds its machine and its project", () => {
  const view = buildClusterView(input({ conversations: [
    // Ido is in Family and Sela, but this project is shared with a cluster he is not in.
    conversation({ sessionId: "elsewhere", executionNodeId: IDO, projectClusterIds: ["33333333-3333-4333-8333-333333333333"] }),
    // A project shared with no cluster at all (the person's own, or one shared with a twin only).
    conversation({ sessionId: "unshared", executionNodeId: MATAN, projectClusterIds: [] }),
    // Matan is not in Family: a project shared with Family alone does not put his agent in front of the person.
    conversation({ sessionId: "family-only", executionNodeId: MATAN, projectClusterIds: [FAMILY] }),
    conversation({ sessionId: "good", executionNodeId: MATAN }),
  ] }));
  assert.deepEqual(view.machines.flatMap((machine) => machine.agents.map((agent) => agent.sessionId)), ["good"]);
});

test("only running work is listed: a turn, or background work; a finished or idle conversation is not", () => {
  const view = buildClusterView(input({ conversations: [
    conversation({ sessionId: "turn", executionNodeId: MATAN }),
    conversation({ sessionId: "background", executionNodeId: MATAN, turnRunning: false, backgroundRunning: true }),
    conversation({ sessionId: "idle", executionNodeId: MATAN, turnRunning: false, backgroundRunning: false }),
  ] }));
  assert.deepEqual(view.machines[0].agents.map((agent) => [agent.sessionId, agent.state]).sort(), [["background", "background"], ["turn", "running"]]);
});

test("a machine with nothing running is still named, and one that is not answering says so", () => {
  const view = buildClusterView(input({ awayNodeIds: new Set([IDO]), conversations: [conversation({ sessionId: "x", executionNodeId: MATAN })] }));
  assert.deepEqual(view.machines.map((machine) => [machine.name, machine.agents.length, machine.away]), [["Matan's Mac", 1, false], ["Ido's Laptop", 0, true]]);
});

test("a person in no cluster, or only with their own machines, has nothing", () => {
  assert.deepEqual(buildClusterView(input({ clusters: [] })), { clusters: [], machines: [], projects: [] });
  const alone: ClusterInfo = { id: SELA, name: "Mine", relay: false, members: [{ nodeId: ME, name: "Mac" }, { nodeId: TWIN, name: "Homeserver" }] };
  const view = buildClusterView(input({ clusters: [alone], conversations: [conversation({ sessionId: "twins", executionNodeId: TWIN })] }));
  assert.deepEqual(view.machines, []);
  assert.deepEqual(view.clusters, [{ id: SELA, name: "Mine", relay: false, machines: 0, running: 0 }]);
});

// ── Bob ───────────────────────────────────────────────────────────────────────────────────────────────

const running: ClusterView = buildClusterView(input({ conversations: [
  conversation({ sessionId: "slice-8", title: "Slice 8 — creator payouts", executionNodeId: MATAN, agentModel: "opus", summary: "Writing the payout job", updatedAt: "2026-11-05T10:00:00Z" }),
] }));
const NOW = Date.parse("2026-11-05T10:03:00Z");

test("Bob's text lists only the running agents, says they are not his to answer, and names who has nothing running", () => {
  const text = clusterAgentsText(running, NOW);
  assert.match(text, /you cannot answer, instruct, stop or message these agents/);
  assert.match(text, /Matan's Mac \(Sela team\):/);
  assert.match(text, /\[DAK Live\] Slice 8 — creator payouts \(Claude opus, running, active 3 min ago\) — Writing the payout job/);
  assert.match(text, /Nothing running that is shared with the user on: Ido's Laptop\./);
  assert.doesNotMatch(text, /Homeserver|Ilia's Mac/, "the person's own machines are not part of it");
  assert.match(clusterAgentsText(buildClusterView(input()), NOW), /Nothing is running right now/);
});

test("the text stays short however much runs", () => {
  const many = buildClusterView(input({ conversations: Array.from({ length: 60 }, (_, index) => conversation({ sessionId: `s${index}`, title: `Task ${index} ${"x".repeat(400)}`, summary: "y".repeat(900), executionNodeId: MATAN })) }));
  const text = clusterAgentsText(many, NOW);
  assert.equal(text.split("\n").filter((line) => line.startsWith("  - [")).length, 25);
  assert.match(text, /…and more not listed here/);
  assert.ok(text.length < 10_000);
  assert.ok(!text.includes("x".repeat(200)), "titles are cut");
});

test("without a model, a message about people is told by a small explicit rule", () => {
  assert.deepEqual([...personWords(running)].sort(), ["family", "ido", "matan", "sela"], "machine kinds and the person's own machines are not names");
  for (const message of ["what is the team doing?", "What's Matan up to", "anything from everyone today", "ask matan's mac", "what is Ido working on", "how are my colleagues doing", "what runs in the cluster"]) assert.equal(namesPeople(message, running), true, message);
  for (const message of ["fix the mobile menu", "what is running in DAK Live?", "move my jobs from the mac to the homeserver", "summarise my last conversation", "the teamwork guide needs an edit"]) assert.equal(namesPeople(message, running), false, message);
});

function turn(message: string, threshold = 0.9): BobTurn {
  return { session: { accountId: "ilia" } as never, message, recentChat: [], project: null, options: [], settings: { ...DEFAULT_BOB_SETTINGS, threshold } };
}

const never = async () => null;

test("the decision model is asked one yes/no question, and a sure answer decides either way", async () => {
  const asked: Array<{ state: string; questions: string[] }> = [];
  const yes = { ask: async (state: string, questions: Record<string, unknown>) => { asked.push({ state, questions: Object.keys(questions) }); return { people: { choice: "yes", confidence: 0.97 } }; }, stateCharacters: 3_500, now: NOW };
  const no = { ask: async () => ({ people: { choice: "no", confidence: 0.95 } }), stateCharacters: 3_500, now: NOW };
  // The rule would say no for the first message and yes for the second; a sure model overrules it both ways.
  assert.deepEqual(await messageIsAboutPeople(running, turn("what are they up to?"), yes), { about: true, by: "decision model" });
  assert.deepEqual(await messageIsAboutPeople(running, turn("the team lead said to fix the menu"), no), { about: false, by: "decision model" });
  assert.deepEqual(asked.map((entry) => entry.questions), [["people"]], "one question, one request");
  const state = JSON.parse(asked[0].state) as { user_message: string; people_and_machines: string[]; clusters: string[] };
  assert.deepEqual(state.people_and_machines, ["Matan's Mac", "Ido's Laptop"]);
  assert.deepEqual(state.clusters, ["Sela team", "Family"]);
});

test("below Bob's saved confidence, or with no model, the rule decides", async () => {
  const unsure = { ask: async () => ({ people: { choice: "no", confidence: 0.6 } }), stateCharacters: 3_500, now: NOW };
  assert.deepEqual(await messageIsAboutPeople(running, turn("what is Matan doing?"), unsure), { about: true, by: "rule" });
  assert.deepEqual(await messageIsAboutPeople(running, turn("what is running here?"), unsure), { about: false, by: "rule" });
  // The person's own threshold applies: 0.6 is enough when they saved 0.5.
  assert.deepEqual(await messageIsAboutPeople(running, turn("what is Matan doing?", 0.5), unsure), { about: false, by: "decision model" });
  const none = { ask: never, stateCharacters: 3_500, now: NOW };
  assert.deepEqual(await messageIsAboutPeople(running, turn("how is the team?"), none), { about: true, by: "rule" });
  assert.deepEqual(await messageIsAboutPeople(running, turn("fix the menu"), none), { about: false, by: "rule" });
});

test("Bob gets the summary only for a message about people, and never asks anything when no one else is in a cluster", async () => {
  let asks = 0;
  const counting = (choice: string) => ({ ask: async () => { asks += 1; return { people: { choice, confidence: 0.99 } }; }, stateCharacters: 3_500, now: NOW });
  const told = await useClusters(running, turn("what is the team doing?"), counting("yes"));
  assert.match(told?.text ?? "", /Slice 8 — creator payouts/);
  assert.equal(told?.via, "Cluster agents: 1 running (decision model)");
  assert.equal(await useClusters(running, turn("fix the menu"), counting("no")), null);
  assert.equal(await useClusters(EMPTY_CLUSTER_VIEW, turn("what is the team doing?"), counting("yes")), null);
  assert.equal(asks, 2, "no model call without anyone else to talk about");
  const told2 = await useClusters(running, turn("how is the team doing?"), { ask: never, stateCharacters: 3_500, now: NOW });
  assert.equal(told2?.via, "Cluster agents: 1 running (rule)");
});

test("the model is not asked to read more than it can: a long message is cut and recent chat is dropped before the state grows too big", async () => {
  let state = "";
  const small = { ask: async (given: string) => { state = given; return null; }, stateCharacters: 400, now: NOW };
  await messageIsAboutPeople(running, { ...turn("a".repeat(5_000)), recentChat: ["b".repeat(300), "c".repeat(300)] }, small);
  assert.ok(!state.includes("recent_chat"), "recent chat goes first when the state does not fit");
  assert.ok(state.length <= 400, "the state fits what the decision model can read");
});
