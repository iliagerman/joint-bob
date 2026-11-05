import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  MAX_PUSHES, nextStep, parseAgentVerdict, pushesSoFar, readReviewCheck, reasonFromAnswer, REVIEW_QUESTION, reviewState, verdictOf, writeReviewCheck, type ReviewCheck,
} from "../src/control-center/review-check.js";

const check = (overrides: Partial<ReviewCheck> = {}): ReviewCheck => ({
  projectId: "p", conversationId: "c", accountId: "a1", verdict: "continue", reason: "Tests are left", by: "Decision model 95%", answerHash: "h1",
  pushes: 1, pushPending: true, needsYou: false, checkedAt: "2026-11-05T10:00:00Z", ...overrides,
});

test("not done is pushed on until the limit, then brought to the person; asking first and waiting for them always bring it to them", () => {
  assert.equal(nextStep("done", "push", 0), "none");
  assert.equal(nextStep("continue", "push", 0), "push");
  assert.equal(nextStep("continue", "push", MAX_PUSHES - 1), "push");
  assert.equal(nextStep("continue", "push", MAX_PUSHES), "tell", "a run of pushes stops before it loops");
  assert.equal(nextStep("continue", "ask", 0), "ask");
  assert.equal(nextStep("needs-user", "push", 0), "tell", "what only the person can give is never pushed past");
});

test("pushes count on only while each turn answers Bob's own push", () => {
  assert.equal(pushesSoFar(undefined), 0);
  assert.equal(pushesSoFar(check({ pushes: 2, pushPending: true })), 2);
  assert.equal(pushesSoFar(check({ pushes: 2, pushPending: false })), 0, "the person spoke since, so the count starts again");
});

test("the decision model reads the request, the summary and the end of the answer within its budget", () => {
  const answer = `${"x".repeat(5000)}\nShall I continue with the migration?`;
  const state = reviewState({ request: "Add the billing page", summary: "**Goal** — billing", answer }, 1500)!;
  assert.ok(state.length <= 1500);
  const parsed = JSON.parse(state) as { user_request: string; agent_last_message: string };
  assert.equal(parsed.user_request, "Add the billing page");
  assert.match(parsed.agent_last_message, /^….*Shall I continue with the migration\?$/s, "the start of the answer is cut, not the end");
  assert.equal(reviewState({ request: "r", summary: null, answer }, 100), null, "a budget too small for the answer is not used");
  assert.deepEqual(Object.keys(REVIEW_QUESTION.criteria).map(verdictOf), ["done", "continue", "needs-user"]);
});

test("Bob's agent's verdict is used only in the asked-for shape, and a reason is found when there is none", () => {
  assert.deepEqual(parseAgentVerdict('Here: {"verdict":"needs-user","reason":"It needs the Stripe key."}'), { verdict: "needs-user", reason: "It needs the Stripe key." });
  assert.equal(parseAgentVerdict('{"verdict":"maybe"}'), null);
  assert.equal(parseAgentVerdict("done"), null);
  assert.equal(reasonFromAnswer("I added the page.\n**Next:** wire the API.\nShould I also add tests?"), "Should I also add tests?");
  assert.equal(reasonFromAnswer("All done; tests pass."), "All done; tests pass.");
});

test("a check is kept per conversation and replaced by the next one", () => {
  const db = new DatabaseSync(":memory:");
  assert.equal(readReviewCheck(db, "p", "c"), undefined);
  writeReviewCheck(db, check());
  writeReviewCheck(db, check({ verdict: "needs-user", needsYou: true, pushPending: false, answerHash: "h2" }));
  assert.deepEqual(readReviewCheck(db, "p", "c"), check({ verdict: "needs-user", needsYou: true, pushPending: false, answerHash: "h2" }));
});
