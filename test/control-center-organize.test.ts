import assert from "node:assert/strict";
import test from "node:test";
import type { BobDecision } from "../src/control-center/decisions.js";
import { mayBeAboutOrganizing, parseOrganizeIntent, propose, type OrganizeIntent, type OrganizeWorld } from "../src/server/control-center-organize.js";

const world: OrganizeWorld = {
  workspaces: [{ id: "work", label: "Work" }, { id: "personal", label: "Personal" }, { id: "empty", label: "Empty" }],
  projects: [{ id: "jb", name: "Joint Bob", workspaceId: "work" }, { id: "dak", name: "DAK Live", workspaceId: "personal" }],
  conversations: [
    { key: "conversation_1", projectId: "dak", projectName: "DAK Live", engine: "claude", sessionId: "s1", conversationId: "c1", title: "slice 10", local: true },
    { key: "conversation_2", projectId: "jb", projectName: "Joint Bob", engine: "pi", sessionId: "s2", conversationId: "c2", title: "Mac build", local: false },
  ],
};
const decision = (kind: BobDecision["kind"]): BobDecision => ({ kind, size: "short", projectId: null, autoRespond: false, confidence: 0.95 });
const proposal = (intent: Exclude<OrganizeIntent, { intent: "none" }>) => {
  const result = propose(intent, world);
  assert.notEqual(typeof result, "string", JSON.stringify(result));
  return result as Exclude<ReturnType<typeof propose>, string>;
};

test("what Bob's agent answers is an intent only when it fits one of the shapes", () => {
  assert.deepEqual(parseOrganizeIntent('Sure:\n{"intent":"create-project","name":"Billing","workspaceId":"work"}'), { intent: "create-project", name: "Billing", workspaceId: "work" });
  assert.deepEqual(parseOrganizeIntent('{"intent":"none"}'), { intent: "none" });
  for (const bad of ["", "create it", '{"intent":"create-project","name":"Billing"}', '{"intent":"drop-database"}', '{"intent":"rename-conversation","conversation":"conversation_1","title":""}']) {
    assert.equal(parseOrganizeIntent(bad), null, bad);
  }
});

test("a message is about arranging work when the decision model says so, it asks a conversation something, or it was not surely a task and names a project, workspace or conversation", () => {
  assert.equal(mayBeAboutOrganizing("anything", decision("organize"), 0.9), true);
  assert.equal(mayBeAboutOrganizing("create a project called Billing", decision("task"), 0.9), false, "work inside a project is a task");
  assert.equal(mayBeAboutOrganizing("create a project called Billing", { ...decision("task"), confidence: 0.46 }, 0.9), true, "a guess under the threshold does not rule it out");
  assert.equal(mayBeAboutOrganizing("create a project called Billing", null, 0.9), true);
  assert.equal(mayBeAboutOrganizing("what is running in the project?", null, 0.9), false, "no change is asked for");
  assert.equal(mayBeAboutOrganizing("pause the nightly schedule", decision("automation"), 0.9), false);
  assert.equal(mayBeAboutOrganizing("I want you to ask the internal assistant conversation under joint bob how to review", decision("task"), 0.9), true, "asking a conversation something");
  assert.equal(mayBeAboutOrganizing("tell me what is running in the project", null, 0.9), false, "telling the person is not messaging a conversation");
});

test("each change is said plainly, carries the exact ids, and a removal is marked as dangerous", () => {
  const created = proposal({ intent: "create-project", name: "Billing", workspaceId: "work" });
  assert.match(created.text, /Create the project "Billing" in the workspace "Work"/);
  assert.deepEqual(created.operation, { op: "create-project", name: "Billing", workspaceId: "work", workspaceName: "Work" });
  assert.equal(created.danger, false);
  const closed = proposal({ intent: "close-conversation", conversation: "conversation_1" });
  assert.deepEqual(closed.operation, { op: "close-conversation", projectId: "dak", engine: "claude", sessionId: "s1", title: "slice 10" });
  assert.deepEqual(closed.project, { id: "dak", name: "DAK Live" });
  const removed = proposal({ intent: "delete-project", projectId: "jb" });
  assert.equal(removed.danger, true);
  assert.match(removed.text, /folder stays on disk/);
  assert.equal(proposal({ intent: "delete-workspace", workspaceId: "empty" }).danger, true);
  const asked = proposal({ intent: "message-conversation", conversation: "conversation_1", message: "how do I review this?" });
  assert.match(asked.text, /^Send this to "slice 10" in DAK Live\? I'll bring you its answer here\.\nhow do I review this\?$/);
  assert.equal(asked.button, "Send it");
  assert.deepEqual(asked.operation, { op: "message-conversation", projectId: "dak", engine: "claude", sessionId: "s1", conversationId: "c1", title: "slice 10", message: "how do I review this?" });
  const deleted = proposal({ intent: "delete-conversation", conversation: "conversation_1" });
  assert.equal(deleted.danger, true);
  assert.deepEqual(deleted.operation, { op: "delete-conversation", projectId: "dak", engine: "claude", sessionId: "s1", title: "slice 10" });
});

test("a change that cannot be done is said so, and nothing is proposed", () => {
  assert.match(propose({ intent: "create-workspace", name: "work" }, world) as string, /already have a workspace called "work"/);
  assert.match(propose({ intent: "delete-workspace", workspaceId: "work" }, world) as string, /still holds "Joint Bob"/);
  assert.match(propose({ intent: "move-project", projectId: "jb", workspaceId: "work" }, world) as string, /already in "Work"/);
  assert.match(propose({ intent: "rename-project", projectId: "made-up", name: "x" }, world) as string, /could not find/);
  assert.match(propose({ intent: "close-conversation", conversation: "conversation_9" }, world) as string, /could not find that conversation/);
  assert.match(propose({ intent: "create-project", name: "x", workspaceId: "nope" }, world) as string, /could not find the workspace/);
  assert.match(propose({ intent: "message-conversation", conversation: "conversation_2", message: "hi" }, world) as string, /"Mac build" runs on another machine/);
  assert.match(propose({ intent: "delete-conversation", conversation: "conversation_9" }, world) as string, /could not find that conversation/);
});
