import { conversationRuntimeDatabase } from "./conversation-runtime.js";
import { refreshAgentRun } from "./agent-run-monitor.js";
const ensured = /* @__PURE__ */ new WeakSet();
function database() {
  const db = conversationRuntimeDatabase();
  if (ensured.has(db)) return db;
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_work (
    engine TEXT NOT NULL, session_id TEXT NOT NULL, run_id TEXT NOT NULL,
    payload TEXT NOT NULL, PRIMARY KEY (engine, session_id, run_id)
  )`);
  ensured.add(db);
  return db;
}
function agentWorkActive(run) {
  return ["queued", "running"].includes(run.status) || run.tasks.some((task) => ["queued", "running"].includes(task.status));
}
function recordConversationWork(work) {
  database().prepare(`INSERT INTO conversation_work VALUES (?, ?, ?, ?)
    ON CONFLICT(engine, session_id, run_id) DO UPDATE SET payload = excluded.payload`).run(work.engine, work.sessionId, work.summary.runId, JSON.stringify({ ...work, observedAt: (/* @__PURE__ */ new Date()).toISOString() }));
}
function listConversationWork(engine, sessionId) {
  const rows = engine !== void 0 && sessionId !== void 0 ? database().prepare("SELECT payload FROM conversation_work WHERE engine = ? AND session_id = ?").all(engine, sessionId) : database().prepare("SELECT payload FROM conversation_work").all();
  return rows.map((row) => JSON.parse(String(row.payload)));
}
function conversationWorkActive(engine, sessionId) {
  return listConversationWork(engine, sessionId).some((work) => agentWorkActive(work.summary));
}
function failActiveTasks(summary, error) {
  return {
    ...summary,
    status: "failed",
    tasks: summary.tasks.map((task) => ["queued", "running"].includes(task.status) ? { ...task, status: "failed", error } : task)
  };
}
function failStaleConversationWork(alive, staleMs, now = Date.now()) {
  const stale = /* @__PURE__ */ new Map();
  for (const work of listConversationWork()) {
    if (work.descriptor || !agentWorkActive(work.summary) || alive(work.engine, work.sessionId)) continue;
    const observedAt = work.observedAt ? Date.parse(work.observedAt) : 0;
    if (now - observedAt < staleMs) continue;
    stale.set(`${work.engine}
${work.sessionId}`, { engine: work.engine, sessionId: work.sessionId });
  }
  return [...stale.values()].filter(({ engine, sessionId }) => failUnobservedConversationWork(engine, sessionId, "Joint Bob stopped tracking this run: it went quiet and no agent process is left"));
}
function failUnobservedConversationWork(engine, sessionId, error) {
  let changed = false;
  for (const work of listConversationWork(engine, sessionId)) {
    if (work.descriptor || !agentWorkActive(work.summary)) continue;
    recordConversationWork({ ...work, summary: failActiveTasks(work.summary, error) });
    changed = true;
  }
  return changed;
}
async function retireUnreachableConversationWorkAfterRestart() {
  let retired = 0;
  await Promise.all(listConversationWork().filter((work) => work.descriptor && agentWorkActive(work.summary)).map(async (work) => {
    let summary;
    try {
      summary = await refreshAgentRun({ ...work.descriptor, summary: work.summary });
    } catch (error) {
      summary = failActiveTasks(work.summary, `Joint Bob restarted and the run's dashboard is unreachable: ${error instanceof Error ? error.message : String(error)}`);
      retired += 1;
    }
    recordConversationWork({ ...work, summary });
  }));
  return retired;
}
function failUnobservedConversationWorkAfterRestart() {
  const sessions = new Set(listConversationWork().filter((work) => work.engine === "claude").map((work) => work.sessionId));
  let failed = 0;
  for (const sessionId of sessions) {
    if (failUnobservedConversationWork("claude", sessionId, "Joint Bob restarted before reporting task completion")) failed += 1;
  }
  return failed;
}
let refreshInFlight;
function refreshConversationWork() {
  return refreshInFlight ??= refreshObservedWork().finally(() => {
    refreshInFlight = void 0;
  });
}
async function refreshObservedWork() {
  let changed = false;
  const described = database().prepare("SELECT payload FROM conversation_work WHERE json_extract(payload, '$.descriptor') IS NOT NULL").all().map((row) => JSON.parse(String(row.payload)));
  await Promise.all(described.filter((work) => work.descriptor && agentWorkActive(work.summary)).map(async (work) => {
    try {
      const summary = await refreshAgentRun({ ...work.descriptor, summary: work.summary });
      if (JSON.stringify(summary) === JSON.stringify(work.summary)) return;
      recordConversationWork({ ...work, summary });
      changed = true;
    } catch {
    }
  }));
  return changed;
}
function applyConversationWork(sessions) {
  const result = sessions.map((session) => {
    const runs = new Map((session.agentRuns ?? []).map((run) => [run.runId, run]));
    for (const work of listConversationWork(session.harnessId, session.id)) runs.set(work.summary.runId, work.summary);
    const backgroundRunning = Boolean(session.backgroundRunning || [...runs.values()].some(agentWorkActive));
    return {
      ...session,
      ...runs.size ? { agentRuns: [...runs.values()] } : {},
      ...backgroundRunning ? { backgroundRunning: true } : {},
      running: Boolean(session.running || backgroundRunning)
    };
  });
  const byPath = new Map(result.map((session) => [session.path, session]));
  for (const session of result) {
    if (!session.running) continue;
    const seen = /* @__PURE__ */ new Set();
    let parent = session.parentSessionPath && byPath.get(session.parentSessionPath);
    while (parent && !seen.has(parent.path)) {
      seen.add(parent.path);
      parent.running = true;
      if (session.backgroundRunning) parent.backgroundRunning = true;
      if (session.turnRunning) parent.turnRunning = true;
      parent = parent.parentSessionPath && byPath.get(parent.parentSessionPath);
    }
  }
  return result;
}
export {
  agentWorkActive,
  applyConversationWork,
  conversationWorkActive,
  failStaleConversationWork,
  failUnobservedConversationWork,
  failUnobservedConversationWorkAfterRestart,
  listConversationWork,
  recordConversationWork,
  refreshConversationWork,
  retireUnreachableConversationWorkAfterRestart
};
