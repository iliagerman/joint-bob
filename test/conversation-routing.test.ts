import assert from "node:assert/strict";
import test from "node:test";
import { classifyConversationChoiceWithSystemOne } from "../src/classifiers/typesafe.js";
import { routeAssistantMessage } from "../src/classifiers/conversation-routing.js";

const target = { endpoint: "http://classifier.test/v1/systemone", model: "fixture", stateCharacters: 4000, timeoutMs: 1000 };

test("conversation choice sends explicit candidates and returns the selected existing topic", async () => {
  let request: Record<string, unknown> | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ answers: { route: { type: "choice", choice: "topic_a", confidence: 0.91, probabilities: { topic_a: 0.91, new_topic: 0.03, recall_history: 0.06 } } } });
  };
  const result = await classifyConversationChoiceWithSystemOne(target, "Continue the laptop comparison", "route", {
    topic_a: "Resume the saved laptop conversation and keep its context.",
    new_topic: "Start a distinct conversation because this is a different subject.",
    recall_history: "Search older conversations to answer a past-decision question without switching topics.",
  }, "fixture-key", fetchImpl);
  assert.deepEqual(result, { choice: "topic_a", confidence: 0.91 });
  assert.deepEqual((request?.questions as Record<string, unknown>).route, {
    type: "choice",
    instructions: "Choose the single action that best handles the new user message. Select a topic option only when the message should resume that exact saved conversation. Choose new_topic only when the user starts a distinct subject. Choose recall_history when the user asks what happened or was decided in past conversations without asking to resume that work.",
    criteria: {
      topic_a: "Resume the saved laptop conversation and keep its context.",
      new_topic: "Start a distinct conversation because this is a different subject.",
      recall_history: "Search older conversations to answer a past-decision question without switching topics.",
    },
  });
});

test("assistant router resumes the classifier-selected original topic", async () => {
  const result = await routeAssistantMessage({
    classifierId: "typesafe", apiKey: "fixture-key", message: "Back to the laptop, choose the second one.", recentMessages: ["Compare two laptops", "Now help with tomorrow's meeting"],
    topics: [{ id: "laptops", title: "Laptop comparison", summary: "Two models, second has longer warranty." }, { id: "meeting", title: "Planning meeting", summary: "Prepare agenda for tomorrow." }],
  }, async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    const choices = body.questions.route.criteria;
    assert.equal(choices.topic_0, "Resume saved conversation laptops, titled Laptop comparison. Two models, second has longer warranty.");
    return Response.json({ answers: { route: { type: "choice", choice: "topic_0", confidence: 0.94 } } });
  });
  assert.deepEqual(result, { kind: "continue", topicId: "laptops" });
});

test("history excerpts inform recall without becoming resumable assistant topics", async () => {
  let request: Record<string, unknown> | undefined;
  const history = [{ id: "other:session", title: "Earlier idea", summary: "The user chose plan B." }];
  const result = await routeAssistantMessage({
    classifierId: "typesafe", apiKey: "fixture-key", message: "What did I choose earlier?", recentMessages: [],
    topics: [{ id: "assistant:topic", title: "Current work", summary: "Working on a feature." }], history,
  }, async (_input, init) => {
    request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ answers: { route: { type: "choice", choice: "recall_history", confidence: 0.9 } } });
  });
  assert.deepEqual(result, { kind: "recall" });
  const state = JSON.parse(String(request?.state));
  assert.deepEqual(state.accessible_history, history);
  assert.ok(!("history_0" in request?.questions.route.criteria));
});

test("conversation choice rejects responses outside the supplied candidates, including inherited object keys", async () => {
  for (const choice of ["topic_from_another_assistant", "toString"]) {
    const result = await classifyConversationChoiceWithSystemOne(target, "message", "route", { new_topic: "New subject" }, "fixture-key", async () => Response.json({ answers: { route: { type: "choice", choice, confidence: 1 } } }));
    assert.equal(result, null);
  }
});
