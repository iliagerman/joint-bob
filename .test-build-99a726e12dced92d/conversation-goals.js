import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDataDirectory } from "./data-directory.js";
import { enqueueReplicationEvent, ensureReplicationSchema, resolveProjectAlias } from "./replication.js";
const BOB_GOAL_MAX_TURNS = 20;
const dataDir = resolveDataDirectory();
let databasePromise;
function parseBobGoalCommand(text) {
  const match = text.trim().match(/^\/bob-goal(?:\s+([\s\S]+))?$/);
  if (!match) return null;
  const argument = match[1]?.trim();
  if (!argument) throw new Error("Usage: /bob-goal <objective>, /bob-goal status, or /bob-goal cancel");
  if (argument === "status") return { action: "status" };
  if (argument === "cancel") return { action: "cancel" };
  return { action: "start", objective: argument };
}
function classifyGoalResponse(text) {
  const finalLine = text.trimEnd().split("\n").at(-1)?.trim() ?? "";
  if (finalLine === "BOB_GOAL_COMPLETE") return { status: "complete" };
  const blocked = finalLine.match(/^BOB_GOAL_BLOCKED:\s*(.+)$/);
  return blocked ? { status: "blocked", blocker: blocked[1].trim().slice(0, 2e3) } : { status: "continue" };
}
function ensureConversationGoalSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_goals (
    project_id TEXT NOT NULL, conversation_id TEXT NOT NULL, objective TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'blocked', 'completed', 'cancelled')),
    turns INTEGER NOT NULL, blocker TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    origin_node_id TEXT NOT NULL, PRIMARY KEY(project_id, conversation_id)
  );`);
}
function fromRow(row) {
  return {
    projectId: row.project_id,
    conversationId: row.conversation_id,
    objective: row.objective,
    status: row.status,
    turns: row.turns,
    blocker: row.blocker,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    originNodeId: row.origin_node_id
  };
}
async function database() {
  databasePromise ??= (async () => {
    await mkdir(dataDir, { recursive: true, mode: 448 });
    const db = new DatabaseSync(path.join(dataDir, "node.db"));
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    ensureConversationGoalSchema(db);
    ensureReplicationSchema(db);
    return db;
  })();
  return databasePromise;
}
function select(db, projectId, conversationId) {
  const row = db.prepare("SELECT * FROM conversation_goals WHERE project_id = ? AND conversation_id = ?").get(projectId, conversationId);
  return row ? fromRow(row) : void 0;
}
function save(db, goal) {
  db.prepare(`INSERT INTO conversation_goals
    (project_id, conversation_id, objective, status, turns, blocker, created_at, updated_at, origin_node_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, conversation_id) DO UPDATE SET objective=excluded.objective, status=excluded.status,
      turns=excluded.turns, blocker=excluded.blocker, created_at=excluded.created_at,
      updated_at=excluded.updated_at, origin_node_id=excluded.origin_node_id`).run(goal.projectId, goal.conversationId, goal.objective, goal.status, goal.turns, goal.blocker, goal.createdAt, goal.updatedAt, goal.originNodeId);
}
function publish(db, goal) {
  enqueueReplicationEvent(db, {
    originNodeId: goal.originNodeId,
    entityType: "conversation.goal",
    entityKey: `${goal.projectId}:${goal.conversationId}`,
    operation: "upsert",
    payload: goal
  });
}
async function change(projectId, conversationId, update) {
  const db = await database();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = select(db, projectId, conversationId);
    const goal = update(current);
    if (goal) {
      save(db, goal);
      publish(db, goal);
    }
    db.exec("COMMIT");
    return goal ?? current;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function getConversationGoal(projectId, conversationId) {
  return select(await database(), projectId, conversationId);
}
function nextTimestamp(current) {
  return new Date(Math.max(Date.now(), current ? Date.parse(current.updatedAt) + 1 : 0)).toISOString();
}
async function startConversationGoal(projectId, conversationId, objective, originNodeId) {
  if (!objective.trim() || objective.length > 1e5) throw new Error("Goal objective must be between 1 and 100000 characters");
  const goal = await change(projectId, conversationId, (current) => {
    const now = nextTimestamp(current);
    return {
      projectId,
      conversationId,
      objective: objective.trim(),
      status: "active",
      turns: 0,
      blocker: null,
      createdAt: now,
      updatedAt: now,
      originNodeId
    };
  });
  return goal;
}
async function cancelConversationGoal(projectId, conversationId, originNodeId) {
  return change(projectId, conversationId, (current) => current && current.status !== "cancelled" ? {
    ...current,
    status: "cancelled",
    blocker: null,
    updatedAt: nextTimestamp(current),
    originNodeId
  } : void 0);
}
async function blockConversationGoal(projectId, conversationId, createdAt, blocker, originNodeId) {
  return change(projectId, conversationId, (current) => current?.status === "active" && current.createdAt === createdAt ? {
    ...current,
    status: "blocked",
    blocker: blocker.slice(0, 2e3),
    updatedAt: nextTimestamp(current),
    originNodeId
  } : void 0);
}
async function recordConversationGoalResponse(projectId, conversationId, createdAt, assistantText, originNodeId) {
  const result = classifyGoalResponse(assistantText);
  return change(projectId, conversationId, (latest) => {
    if (!latest || latest.status !== "active" || latest.createdAt !== createdAt) return void 0;
    const turns = latest.turns + 1;
    const limitReached = result.status === "continue" && turns >= BOB_GOAL_MAX_TURNS;
    return {
      ...latest,
      turns,
      status: result.status === "complete" ? "completed" : result.status === "blocked" || limitReached ? "blocked" : "active",
      blocker: result.status === "blocked" ? result.blocker : limitReached ? `Automatic continuation limit reached after ${BOB_GOAL_MAX_TURNS} turns` : null,
      updatedAt: nextTimestamp(latest),
      originNodeId
    };
  });
}
function goalPrompt(goal) {
  const work = goal.turns === 0 ? `Joint Bob goal: ${goal.objective}

Work autonomously until this goal is complete or genuinely blocked.` : `Continue the active Joint Bob goal: ${goal.objective}

Do the next unfinished work. Do not stop merely to provide a progress update.`;
  return `${work}

When finished and verified, end with BOB_GOAL_COMPLETE. When user action is required, end with BOB_GOAL_BLOCKED: <specific reason>. Otherwise keep working.`;
}
function goalStatusMessage(goal) {
  if (!goal) return "No /bob-goal has been started for this conversation.";
  if (goal.status === "active") return `Goal active after ${goal.turns} turns: ${goal.objective}`;
  if (goal.status === "blocked") return `Goal blocked after ${goal.turns} turns: ${goal.blocker}`;
  if (goal.status === "completed") return `Goal completed after ${goal.turns} turns: ${goal.objective}`;
  return `Goal cancelled after ${goal.turns} turns: ${goal.objective}`;
}
function goalPayload(event) {
  const value = event.payload;
  if (event.entityType !== "conversation.goal" || event.operation !== "upsert" || !value || typeof value !== "object" || Array.isArray(value) || typeof value.projectId !== "string" || !value.projectId || value.projectId.length > 120 || typeof value.conversationId !== "string" || !value.conversationId || value.conversationId.length > 240 || typeof value.objective !== "string" || !value.objective.trim() || value.objective.length > 1e5 || !["active", "blocked", "completed", "cancelled"].includes(value.status ?? "") || !Number.isInteger(value.turns) || Number(value.turns) < 0 || Number(value.turns) > BOB_GOAL_MAX_TURNS || !(value.blocker === null || typeof value.blocker === "string" && value.blocker.length > 0 && value.blocker.length <= 2e3) || value.status === "blocked" !== (typeof value.blocker === "string") || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)) || value.createdAt > value.updatedAt || typeof value.originNodeId !== "string" || value.originNodeId !== event.originNodeId || event.entityKey !== `${value.projectId}:${value.conversationId}`) throw new Error("Malformed conversation goal replication payload");
  return value;
}
function applyConversationGoalEvent(db, event) {
  const incoming = goalPayload(event);
  const goal = { ...incoming, projectId: resolveProjectAlias(db, incoming.projectId) };
  ensureConversationGoalSchema(db);
  const current = select(db, goal.projectId, goal.conversationId);
  if (current && `${goal.updatedAt}
${goal.originNodeId}` <= `${current.updatedAt}
${current.originNodeId}`) return;
  save(db, goal);
}
export {
  BOB_GOAL_MAX_TURNS,
  applyConversationGoalEvent,
  blockConversationGoal,
  cancelConversationGoal,
  classifyGoalResponse,
  ensureConversationGoalSchema,
  getConversationGoal,
  goalPrompt,
  goalStatusMessage,
  parseBobGoalCommand,
  recordConversationGoalResponse,
  startConversationGoal
};
