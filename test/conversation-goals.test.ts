import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  applyConversationGoalEvent,
  classifyGoalResponse,
  ensureConversationGoalSchema,
  getConversationGoal,
  parseBobGoalCommand,
  recordConversationGoalResponse,
  startConversationGoal,
  type ConversationGoal,
} from "../src/conversation-goals.js";
import type { ReplicationEvent } from "../src/replication.js";

const originNodeId = "00000000-0000-4000-8000-000000000001";

function goal(updatedAt: string, status: ConversationGoal["status"] = "active"): ConversationGoal {
  return {
    projectId: "project-one",
    conversationId: "conversation-one",
    objective: "finish the implementation",
    status,
    turns: status === "active" ? 1 : 2,
    blocker: status === "blocked" ? "Need deployment approval" : null,
    createdAt: "2026-09-11T10:00:00.000Z",
    updatedAt,
    originNodeId,
  };
}

function event(value: ConversationGoal): ReplicationEvent {
  return {
    id: randomUUID(),
    originNodeId: value.originNodeId,
    entityType: "conversation.goal",
    entityKey: `${value.projectId}:${value.conversationId}`,
    operation: "upsert",
    payload: value,
    createdAt: value.updatedAt,
  };
}

test("bob-goal commands are unambiguous and reject missing objectives", () => {
  assert.deepEqual(parseBobGoalCommand("/bob-goal ship the fix"), { action: "start", objective: "ship the fix" });
  assert.deepEqual(parseBobGoalCommand(" /bob-goal status "), { action: "status" });
  assert.deepEqual(parseBobGoalCommand("/bob-goal cancel"), { action: "cancel" });
  assert.equal(parseBobGoalCommand("normal prompt"), null);
  assert.throws(() => parseBobGoalCommand("/bob-goal"), /Usage/);
});

test("goal completion and blockers require an exact final protocol line", () => {
  assert.deepEqual(classifyGoalResponse("Still working"), { status: "continue" });
  assert.deepEqual(classifyGoalResponse("I might later print BOB_GOAL_COMPLETE"), { status: "continue" });
  assert.deepEqual(classifyGoalResponse("Finished and tested.\nBOB_GOAL_COMPLETE"), { status: "complete" });
  assert.deepEqual(classifyGoalResponse("Cannot deploy.\nBOB_GOAL_BLOCKED: Need deployment approval"), {
    status: "blocked",
    blocker: "Need deployment approval",
  });
});

test("automatic continuation stops at the hard turn limit", async () => {
  const projectId = `project-${randomUUID()}`;
  const conversationId = randomUUID();
  const started = await startConversationGoal(projectId, conversationId, "finish bounded work", originNodeId);
  for (let turn = 0; turn < 20; turn++) {
    await recordConversationGoalResponse(projectId, conversationId, started.createdAt, "Still working", originNodeId);
  }
  const stored = await getConversationGoal(projectId, conversationId);
  assert.equal(stored?.status, "blocked");
  assert.equal(stored?.turns, 20);
  assert.match(stored?.blocker ?? "", /limit reached after 20 turns/);
});

test("replicated goal state is last-writer-wins and validates identity", () => {
  const db = new DatabaseSync(":memory:");
  ensureConversationGoalSchema(db);
  const active = goal("2026-09-11T11:00:00.000Z");
  const completed = goal("2026-09-11T12:00:00.000Z", "completed");
  applyConversationGoalEvent(db, event(completed));
  applyConversationGoalEvent(db, event(active));
  const stored = db.prepare("SELECT status, turns FROM conversation_goals WHERE project_id = ? AND conversation_id = ?").get(active.projectId, active.conversationId) as { status: string; turns: number };
  assert.deepEqual({ ...stored }, { status: "completed", turns: 2 });
  assert.throws(() => applyConversationGoalEvent(db, { ...event(active), entityKey: "wrong" }), /Malformed conversation goal/);
  db.close();
});
