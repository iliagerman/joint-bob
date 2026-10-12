import assert from "node:assert/strict";
import test from "node:test";
import { BudgetExceededError } from "../src/budgets.js";
import { guardSession } from "../src/budget-guard.js";
import type { HarnessPrompt, HarnessSession } from "../src/harnesses/runtime.js";

/** A session whose model runs only if the caller's fence lets it. */
function fakeSession(): { session: HarnessSession; ran: string[] } {
  const ran: string[] = [];
  const session = {
    async prompt(input: HarnessPrompt) { await input.beforeStart?.(); ran.push(`prompt:${input.text}`); },
    async compact(_instructions?: string, beforeStart?: () => Promise<void>) { await beforeStart?.(); ran.push("compact"); },
  } as unknown as HarnessSession;
  return { session, ran };
}
const exceeded = (message: string) => async () => { throw new BudgetExceededError(message, undefined as never); };

test("a turn runs when its budgets have room, after the caller's own fence", async () => {
  const { session, ran } = fakeSession();
  const order: string[] = [];
  guardSession(session, { projectId: "p", sessionId: "s", conversationId: "c" }, async (project, conversation) => { order.push(`budget:${project}:${conversation}`); });
  await session.prompt({ text: "hi", beforeStart: async () => { order.push("caller"); } });
  assert.deepEqual(order, ["caller", "budget:p:c"]);
  assert.deepEqual(ran, ["prompt:hi"]);
});

test("a used-up budget stops the prompt before the model runs, and says why", async () => {
  const { session, ran } = fakeSession();
  guardSession(session, { projectId: "p", sessionId: "s" }, exceeded("Budget reached: the daily limit"));
  await assert.rejects(session.prompt({ text: "hi" }), /Budget reached: the daily limit/);
  assert.deepEqual(ran, []);
});

test("compaction and internal runs without their own fence are gated too", async () => {
  const { session, ran } = fakeSession();
  guardSession(session, { projectId: "p", sessionId: "s" }, exceeded("Budget reached"));
  await assert.rejects(session.compact(), /Budget reached/);
  await assert.rejects(session.prompt({ text: "review" }), /Budget reached/);
  assert.deepEqual(ran, []);
});

test("the conversation defaults to the session id", async () => {
  const { session } = fakeSession();
  const seen: Array<string | undefined> = [];
  guardSession(session, { projectId: "p", sessionId: "session-1" }, async (_project, conversation) => { seen.push(conversation); });
  await session.prompt({ text: "x" });
  assert.deepEqual(seen, ["session-1"]);
});
