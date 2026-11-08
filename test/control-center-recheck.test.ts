import assert from "node:assert/strict";
import test from "node:test";
import type { BobMessage } from "../src/control-center/bob-store.js";
import { evidenceHash, isOpenItem, relevanceEvidence, relevanceState, replacedItems, settledByFacts, subjectOf, type ConversationNow } from "../src/control-center/recheck.js";

const POSTED = "2026-11-07T10:00:00.000Z";
const later = (seconds: number) => new Date(Date.parse(POSTED) + seconds * 1000).toISOString();

function item(change: Partial<BobMessage> = {}): BobMessage {
  return {
    id: "item", role: "bob", text: "\"Fix the menu\" waits for you.", via: "Review check · Decision model 97%", projectId: "p1", projectName: "Joint Bob", importance: "needs-you",
    actions: [
      { id: "conversation.done", label: "Done", data: { projectId: "p1", conversationId: "c1" } },
      { id: "open", label: "Open", data: { open: { projectId: "p1", conversationId: "c1", title: "Fix the menu" } } },
    ],
    createdAt: POSTED, resolvedAt: null, resolution: null, ...change,
  };
}
const guardian = item({ id: "guard", role: "system", importance: "needs-ok", actions: [{ id: "guardian.allow", label: "Allow once", data: { projectId: "p1", conversationId: "c1", reviewId: "r1" } }, { id: "guardian.block", label: "Block", data: { reviewId: "r1" } }] });
const conversation = (state: ConversationNow["state"], updatedAt: string | null = POSTED): ConversationNow => ({ state, updatedAt, title: "Fix the menu", summary: "Menu fixed on desktop; mobile waits for a decision." });

test("an item is a message that waits for a button press: not a report, not one already cleared, not one that only opens something", () => {
  assert.equal(isOpenItem(item()), true);
  assert.equal(isOpenItem(item({ importance: "report" })), false, "a report's buttons are shortcuts");
  assert.equal(isOpenItem(item({ resolvedAt: later(5), resolution: "You chose “Done”.", actions: [] })), false);
  assert.equal(isOpenItem(item({ actions: [{ id: "open", label: "Open", data: { open: { projectId: "p1", conversationId: "c1" } } }] })), false, "an answer with an Open button asks nothing");
  assert.equal(isOpenItem(item({ actions: [{ id: "display.undo", label: "Undo", data: { appearance: { theme: "dark" } } }] })), false);
});

test("an item is about the Guardian step or the conversation its buttons name", () => {
  assert.deepEqual(subjectOf(item()), { kind: "conversation", projectId: "p1", conversationId: "c1" });
  assert.deepEqual(subjectOf(guardian), { kind: "guardian", reviewId: "r1" });
  assert.deepEqual(subjectOf(item({ actions: [{ id: "open", label: "Open", data: { open: { projectId: "p1", conversationId: "c9" } } }] })), { kind: "conversation", projectId: "p1", conversationId: "c9" });
  assert.equal(subjectOf(item({ actions: [{ id: "organize.run", label: "Create it", data: { operation: {} } }] })), null);
  assert.equal(subjectOf(item({ projectId: null })), null, "a conversation is named within its project");
});

test("a newer item about the same conversation replaces the older one; Guardian steps and other conversations stand alone", () => {
  const older = item({ id: "older", importance: "fyi" });
  const newer = item({ id: "newer", createdAt: later(120) });
  const other = item({ id: "other", actions: [{ id: "conversation.done", label: "Done", data: { conversationId: "c2" } }] });
  assert.deepEqual([...replacedItems([older, guardian, newer, other])], ["older"]);
});

test("the facts settle an item when its conversation was closed, looked at, answered or moved on, or its Guardian step was answered", () => {
  const settle = (message: BobMessage, now?: ConversationNow, replaced = false, guardianPending?: boolean) => settledByFacts(message, { conversation: now, replaced, guardianPending });
  assert.equal(settle(item(), conversation("waiting")), null, "still waiting");
  assert.equal(settle(item(), conversation("done")), "It was marked done.");
  assert.equal(settle(item(), conversation("reviewed")), null, "looking at a conversation does not answer what it asks");
  assert.equal(settle(item(), conversation("running")), "It is running again.");
  assert.equal(settle(item(), conversation("waiting", later(30))), null, "activity right after the item is the turn it is about");
  assert.equal(settle(item(), conversation("waiting", later(90))), "It moved on since.");
  assert.equal(settle(item(), conversation("missing")), null, "a conversation not found is left to the decision model");
  assert.equal(settle(item(), undefined, true), "A newer message about it replaced it.");
  // Bob's note that he pushed it on is about the turn that runs now: only closing or looking at it settles it.
  const pushed = item({ importance: "fyi" });
  assert.equal(settle(pushed, conversation("running")), null);
  assert.equal(settle(pushed, conversation("waiting", later(600))), null);
  assert.equal(settle(pushed, conversation("reviewed")), "You looked at it.");
  assert.equal(settle(guardian, conversation("reviewed"), false, true), null, "a Guardian step waits until it is answered");
  assert.equal(settle(guardian, undefined, false, false), "The step was answered, or it timed out.");
  assert.equal(settle(guardian, undefined, false, undefined), null, "another machine's step is not known here");
  assert.equal(settle(item({ actions: [{ id: "organize.run", label: "Create it" }] }), conversation("done")), null, "an item about no conversation");
});

test("the decision model reads the item, its conversation and the log since, within its budget, and the same evidence is judged once", () => {
  const log: BobMessage[] = [
    item({ id: "m1", role: "user", text: "never mind the menu, I fixed it myself", actions: [], createdAt: later(60) }),
    item({ id: "m2", text: "\"Fix the login\" waits for you.", createdAt: later(120), resolvedAt: later(130), resolution: "You chose “Done”.", actions: [] }),
  ];
  const evidence = relevanceEvidence(item(), conversation("waiting"), log);
  assert.deepEqual(evidence.item.buttons, ["Done", "Open"]);
  assert.equal(evidence.conversation?.state, "waiting");
  assert.deepEqual(evidence.log.map((entry) => [entry.from, entry.text]), [
    ["user", "never mind the menu, I fixed it myself"],
    ["Bob", "\"Fix the login\" waits for you. [cleared: You chose “Done”.]"],
  ]);
  const state = JSON.parse(relevanceState(evidence, 12, 10_000)!) as { posted_minutes_ago: number; log: unknown[] };
  assert.equal(state.posted_minutes_ago, 12);
  assert.equal(state.log.length, 2);
  const tight = JSON.stringify({ ...evidence, posted_minutes_ago: 12, log: evidence.log.slice(1) }).length;
  assert.equal((JSON.parse(relevanceState(evidence, 12, tight)!) as { log: unknown[] }).log.length, 1, "the oldest log entry goes first");
  assert.equal(relevanceState(evidence, 12, 100), null, "too little room for the item itself");
  assert.equal(evidenceHash(evidence), evidenceHash(relevanceEvidence(item(), conversation("waiting"), log)));
  assert.notEqual(evidenceHash(evidence), evidenceHash(relevanceEvidence(item(), conversation("waiting"), log.slice(0, 1))), "a new entry in the log is new evidence");
});
