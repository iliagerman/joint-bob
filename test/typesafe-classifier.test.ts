import assert from "node:assert/strict";
import test from "node:test";
import { classifyWithTypesafe, DIFFICULTY_RUBRIC, levelFromAnswer } from "../src/classifiers/typesafe.js";
import { getDifficultyClassifier, listDifficultyClassifiers } from "../src/classifiers/registry.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function scoreAnswer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "score", score: 6.2, confidence: 0.8, probabilities: { "5": 0.1, "6": 0.8, "7": 0.1 }, ...overrides };
}

test("levelFromAnswer picks the highest-probability level on the 1 to 10 scale", () => {
  const classification = levelFromAnswer(scoreAnswer());
  assert.ok(classification, "answer must parse");
  assert.equal(classification.level, 7);
  assert.equal(classification.score, 7.2);
  assert.equal(classification.confidence, 0.8);
});

test("levelFromAnswer falls back to the rounded score without probabilities", () => {
  const classification = levelFromAnswer(scoreAnswer({ probabilities: undefined }));
  assert.ok(classification);
  assert.equal(classification.level, 7);
});

test("levelFromAnswer rejects answers without a score or confidence", () => {
  assert.equal(levelFromAnswer({ type: "score", score: "high" }), null);
  assert.equal(levelFromAnswer({ score: 1 }), null);
});

test("classifyWithTypesafe sends one score question with the ten-level rubric and parses the answer", async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  const fetchImpl: typeof fetch = async (url, init) => {
    captured = { url: String(url), init: init! };
    return jsonResponse(200, { model: "jev-1.13.0", answers: { complexity: scoreAnswer() }, usage: { input_tokens: 10, output_tokens: 1 } });
  };
  const classification = await classifyWithTypesafe("Refactor the scheduler for concurrency", "key-1", "", fetchImpl);
  assert.ok(classification);
  assert.equal(classification.level, 7);
  assert.equal(captured.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal((captured.init.headers as Record<string, string>).Authorization, "Bearer key-1");
  const body = JSON.parse(String(captured.init.body));
  assert.equal(body.model, "jev-latest");
  assert.equal(body.questions.complexity.type, "score");
  assert.equal(body.questions.complexity.criteria.length, DIFFICULTY_RUBRIC.length);
  assert.equal(body.questions.complexity.criteria.length, 10);
});

test("classifyWithTypesafe preserves the newest text when state exceeds its budget", async () => {
  let state = "";
  const fetchImpl: typeof fetch = async (_url, init) => {
    state = (JSON.parse(String(init!.body)) as { state: string }).state;
    return jsonResponse(200, { answers: { complexity: scoreAnswer() } });
  };
  await classifyWithTypesafe(`${"old".repeat(50_000)}\nCURRENT PROMPT`, "key", "", fetchImpl);
  assert.ok(state.length <= 120_000);
  assert.match(state, /CURRENT PROMPT$/);
});

test("classifyWithTypesafe retries a 429 once and then succeeds", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return calls === 1 ? jsonResponse(429, { error: "rate limited" }) : jsonResponse(200, { answers: { complexity: scoreAnswer() } });
  };
  const classification = await classifyWithTypesafe("text", "key", "", fetchImpl);
  assert.equal(calls, 2);
  assert.equal(classification?.level, 7);
});

test("classifyWithTypesafe returns null after repeated server errors", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return jsonResponse(503, {});
  };
  assert.equal(await classifyWithTypesafe("text", "key", "", fetchImpl), null);
  assert.equal(calls, 2);
});

test("classifyWithTypesafe returns null on network failure, malformed JSON, or a missing answer", async () => {
  assert.equal(await classifyWithTypesafe("text", "key", "", async () => { throw new Error("offline"); }), null);
  assert.equal(await classifyWithTypesafe("text", "key", "", async () => new Response("not json", { status: 200 })), null);
  assert.equal(await classifyWithTypesafe("text", "key", "", async () => jsonResponse(200, { answers: {} })), null);
});

test("classifyWithTypesafe refuses blank input or a missing key", async () => {
  let called = false;
  const fetchImpl: typeof fetch = async () => { called = true; return jsonResponse(200, { answers: { complexity: scoreAnswer() } }); };
  assert.equal(await classifyWithTypesafe("   ", "key", "", fetchImpl), null);
  assert.equal(await classifyWithTypesafe("text", "", "", fetchImpl), null);
  assert.equal(called, false);
});

test("the registry exposes the typesafe classifier under its policy id", () => {
  const classifier = getDifficultyClassifier("typesafe");
  assert.ok(classifier);
  assert.equal(classifier.variableName, "TYPESAFE_AI_API_KEY");
  assert.ok(listDifficultyClassifiers().some((entry) => entry.id === "typesafe"));
});

test("classifyWithTypesafe keeps a fixed question without configured options", async () => {
  let captured: unknown;
  const fetchImpl: typeof fetch = async (_url, init) => {
    captured = JSON.parse(String(init!.body));
    return jsonResponse(200, { answers: { complexity: scoreAnswer() } });
  };
  await classifyWithTypesafe("text", "key", "   ", fetchImpl);
  const instructions = (captured as { questions: { complexity: { instructions: unknown } } }).questions.complexity.instructions;
  assert.equal(typeof instructions, "string");
});

test("classifyWithTypesafe offers only configured levels and an escape choice", async () => {
  let captured: unknown;
  const fetchImpl: typeof fetch = async (_url, init) => {
    captured = JSON.parse(String(init!.body));
    return jsonResponse(200, { answers: { complexity: { type: "choice", choice: "level_6", confidence: 0.91, probabilities: { level_2: 0.01, level_3: 0.03, level_6: 0.91, level_10: 0.03, none: 0.02 } } } });
  };
  const classification = await classifyWithTypesafe("text", "key", { options: [
    { level: 10, description: "Cross-system architecture" },
    { level: 6, description: "Complex multi-file change" },
    { level: 3, description: "Localized routine edit" },
    { level: 2, description: "Tiny obvious fix" },
  ] }, fetchImpl);
  assert.equal(classification?.level, 6);
  const question = (captured as { questions: { complexity: { type: string; instructions: string; criteria: Record<string, unknown> } } }).questions.complexity;
  assert.equal(question.type, "choice");
  assert.equal(question.instructions, "Which configured option best fits this software development request? Choose `none` when none of the options fits.");
  assert.deepEqual(question.criteria, {
    level_2: "Tiny obvious fix",
    level_3: "Localized routine edit",
    level_6: "Complex multi-file change",
    level_10: "Cross-system architecture",
    none: "None of the configured options fits. Keep the conversation's current model and reasoning.",
  });
});

test("classifyWithTypesafe can decline every configured level", async () => {
  const fetchImpl: typeof fetch = async () => jsonResponse(200, { answers: { complexity: { type: "choice", choice: "none", confidence: 0.88, probabilities: { level_3: 0.12, none: 0.88 } } } });
  const classification = await classifyWithTypesafe("text", "key", { options: [{ level: 3, description: "Localized routine edit" }] }, fetchImpl);
  assert.equal(classification?.abstained, true);
  assert.equal(classification?.confidence, 0.88);
});
