import assert from "node:assert/strict";
import test from "node:test";
import { sessionDoneSchema } from "../src/server/schemas.js";
import { closeoutAssessment, inactiveConversation, type CloseoutDeps } from "../src/conversation-closeout.js";

const deps = (calls: string[]): CloseoutDeps => ({
  classify: async () => { calls.push("classify"); return "bad"; },
  describe: async (rating, description) => { calls.push(`describe:${rating}:${description}`); return { description: description || "The agent missed a requirement.", rules: [{ subject: "requirements", text: "Check every stated requirement.", evidence: "Missed a requirement" }] }; },
  select: async () => { calls.push("select"); return [0]; },
});

test("Done accepts optional feedback for both ratings, and rejects invalid input", () => {
  for (const rating of ["good", "bad", "unimportant"]) {
    assert.equal(sessionDoneSchema.safeParse({ sessionId: "x", engine: "pi", done: true, feedback: { rating } }).success, true);
  }
  assert.equal(sessionDoneSchema.safeParse({ sessionId: "x", engine: "pi", done: true, feedback: { rating: "bad", description: "x".repeat(1001) } }).success, false);
});

test("unimportant does not call either model", async () => {
  const calls: string[] = [];
  assert.deepEqual(await closeoutAssessment({ rating: "unimportant", description: "" }, deps(calls)), { rating: "unimportant", description: "", rules: [] });
  assert.deepEqual(calls, []);
});

test("manual negative feedback is not reclassified and its description wins", async () => {
  const calls: string[] = [];
  const result = await closeoutAssessment({ rating: "bad", description: "Ignored my requirements." }, deps(calls));
  assert.equal(result.description, "Ignored my requirements.");
  assert.equal(result.rules.length, 1);
  assert.deepEqual(calls, ["describe:bad:Ignored my requirements.", "select"]);
});

test("blank positive feedback gets an agent description and decision-model review", async () => {
  const calls: string[] = [];
  const result = await closeoutAssessment({ rating: "good", description: "" }, deps(calls));
  assert.equal(result.rating, "good");
  assert.ok(result.description);
  assert.deepEqual(calls, ["describe:good:", "select"]);
});

test("automatic classification precedes learning and skips it for unimportant", async () => {
  const calls: string[] = [];
  const automatic = deps(calls);
  automatic.classify = async () => { calls.push("classify"); return "unimportant"; };
  assert.equal((await closeoutAssessment(null, automatic)).rules.length, 0);
  assert.deepEqual(calls, ["classify"]);
});

test("decision failure is surfaced instead of saving unreviewed rules", async () => {
  const boundary = deps([]);
  boundary.select = async () => { throw new Error("Decision model unavailable"); };
  await assert.rejects(closeoutAssessment({ rating: "bad", description: "" }, boundary), /Decision model unavailable/);
});

test("inactivity uses message timestamps, strictly more than four days, and excludes busy and done", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  const old = [{ role: "user", timestamp: "2026-11-06T11:59:59Z" }];
  assert.equal(inactiveConversation(old, false, false, now), true);
  assert.equal(inactiveConversation([{ role: "assistant", timestamp: "2026-11-06T12:00:00Z" }], false, false, now), false);
  assert.equal(inactiveConversation(old, true, false, now), false);
  assert.equal(inactiveConversation(old, false, true, now), false);
  assert.equal(inactiveConversation([], false, false, now), false);
  assert.equal(inactiveConversation([...old, { role: "assistant", timestamp: "2026-11-10T11:00:00Z" }], false, false, now), false);
});
