import assert from "node:assert/strict";
import test from "node:test";
import type { SystemOneChoice, SystemOneQuestion } from "../src/classifiers/typesafe.js";
import { decideForBob, groupProjects, needsAgentDecision, type BobProjectOption } from "../src/control-center/decisions.js";

const projects: BobProjectOption[] = [
  { id: "jb", name: "Joint Bob", headlines: ["Mobile menu quick actions", "Review counter fix"] },
  { id: "dak", name: "DAK Live", headlines: ["Slice 7 explore map", "Community Plus billing"] },
  { id: "julian", name: "Contigos Julian", headlines: ["VPlans 400 fix"] },
];

/** A stand-in decision model: picks the project whose name or headlines share a word with the message. */
function fakeModel(options: { confidence?: number; kind?: string; size?: string; autoRespond?: string; fail?: (state: string) => boolean } = {}) {
  const requests: Array<{ state: string; questions: string[] }> = [];
  const ask = async (state: string, questions: Record<string, SystemOneQuestion>): Promise<Record<string, SystemOneChoice> | null> => {
    requests.push({ state, questions: Object.keys(questions) });
    if (options.fail?.(state)) return null;
    const message = (JSON.parse(state) as { user_message: string }).user_message.toLowerCase();
    const confidence = options.confidence ?? 0.95;
    const answers: Record<string, SystemOneChoice> = {};
    if (questions.kind) answers.kind = { choice: options.kind ?? "task", confidence };
    if (questions.size) answers.size = { choice: options.size ?? "long", confidence };
    if (questions.autorespond) answers.autorespond = { choice: options.autoRespond ?? "yes", confidence };
    if (questions.project) {
      const entry = Object.entries(questions.project.criteria).find(([key, text]) => key !== "none" && text.toLowerCase().split(/\W+/).some((word) => word.length > 3 && message.includes(word)));
      answers.project = { choice: entry?.[0] ?? "none", confidence };
    }
    return answers;
  };
  return { ask, requests };
}

test("one batched request decides the kind, the size and the project", async () => {
  const model = fakeModel();
  const decision = await decideForBob({ message: "fix the mobile menu", recentChat: [], projects, ask: model.ask, stateCharacters: 120_000 });
  assert.deepEqual(decision, { kind: "task", size: "long", projectId: "jb", autoRespond: true, confidence: 0.95, kindConfidence: 0.95 });
  assert.equal(model.requests.length, 1, "everything fits one request");
  assert.deepEqual(model.requests[0].questions.sort(), ["autorespond", "kind", "project", "size"]);
});

test("a message about no listed project has no project", async () => {
  const decision = await decideForBob({ message: "what is the weather", recentChat: [], projects, ask: fakeModel({ kind: "other", size: "short" }).ask, stateCharacters: 120_000 });
  assert.equal(decision?.projectId, null);
  assert.equal(decision?.kind, "other");
});

test("the person's own project choice is not asked and the confidence comes from the rest", async () => {
  const model = fakeModel({ confidence: 0.8 });
  const decision = await decideForBob({ message: "anything", recentChat: [], projects, ask: model.ask, stateCharacters: 120_000, fixedProjectId: "dak" });
  assert.equal(decision?.projectId, "dak");
  assert.equal(decision?.confidence, 0.8);
  assert.deepEqual(model.requests[0].questions.sort(), ["autorespond", "kind", "size"]);
});

test("many projects split into groups that are asked in parallel, then one final request picks among the winners", async () => {
  const many: BobProjectOption[] = Array.from({ length: 12 }, (_, index) => ({ id: `p${index}`, name: `Project ${index}`, headlines: [`topic${index} work ${"x".repeat(60)}`] }));
  const model = fakeModel();
  // Both the first and the last group name a project: the message mentions two projects' topics.
  const decision = await decideForBob({ message: "topic0 and topic11", recentChat: [], projects: many, ask: model.ask, stateCharacters: 1_200 });
  assert.ok(model.requests.length >= 3, `several group requests and a final one, got ${model.requests.length}`);
  assert.equal(model.requests[0].questions.includes("kind"), true, "only the first group carries the kind and size questions");
  assert.equal(model.requests[1].questions.includes("kind"), false);
  assert.ok(decision?.projectId === "p0" || decision?.projectId === "p11");
});

test("groupProjects keeps every project and respects the state budget", () => {
  const many: BobProjectOption[] = Array.from({ length: 30 }, (_, index) => ({ id: `p${index}`, name: `Project ${index}`, headlines: ["a headline of some length here"] }));
  const groups = groupProjects(many, { message: "m", recentChat: [], stateCharacters: 1_500 });
  assert.equal(groups.flat().length, 30);
  assert.ok(groups.length > 1);
  assert.deepEqual(groupProjects(many, { message: "m", recentChat: [], stateCharacters: 1_000_000 }).length, 1);
});

test("the lowest confidence wins, and a decision below the threshold goes to the agent", async () => {
  const decision = await decideForBob({ message: "fix the mobile menu", recentChat: [], projects, ask: fakeModel({ confidence: 0.7 }).ask, stateCharacters: 120_000 });
  assert.equal(decision?.confidence, 0.7);
  assert.equal(needsAgentDecision(decision, 0.9), true);
  assert.equal(needsAgentDecision({ ...decision!, confidence: 0.95 }, 0.9), false);
});

test("a model that cannot answer, or an empty message, gives no decision", async () => {
  assert.equal(await decideForBob({ message: "hi", recentChat: [], projects, ask: fakeModel({ fail: () => true }).ask, stateCharacters: 120_000 }), null);
  assert.equal(await decideForBob({ message: "  ", recentChat: [], projects, ask: fakeModel().ask, stateCharacters: 120_000 }), null);
  assert.equal(needsAgentDecision(null, 0.9), true);
});

test("a task continues the conversation it belongs to, or starts a new one", async () => {
  const { chooseConversation } = await import("../src/control-center/decisions.js");
  const options = [{ id: "c1", title: "Mobile menu quick actions", summary: "Menu now leads with mark as done" }, { id: "c2", title: "Review counter fix", summary: null }];
  const ask = (choice: string, confidence = 0.95) => async () => ({ conversation: { choice, confidence } });
  assert.deepEqual(await chooseConversation({ message: "also add auto respond to the menu", recentChat: [], options, ask: ask("conversation_0"), stateCharacters: 100_000 }), { conversationId: "c1", confidence: 0.95 });
  assert.deepEqual(await chooseConversation({ message: "something else", recentChat: [], options, ask: ask("none", 0.8), stateCharacters: 100_000 }), { conversationId: null, confidence: 0.8 });
  assert.deepEqual(await chooseConversation({ message: "first task", recentChat: [], options: [], ask: ask("none"), stateCharacters: 100_000 }), { conversationId: null, confidence: 1 }, "nothing to continue, no question asked");
  assert.equal(await chooseConversation({ message: "x", recentChat: [], options, ask: async () => null, stateCharacters: 100_000 }), null);
  assert.equal(await chooseConversation({ message: "x", recentChat: [], options, ask: ask("none"), stateCharacters: 10 }), null, "a state that does not fit is never truncated");
});
