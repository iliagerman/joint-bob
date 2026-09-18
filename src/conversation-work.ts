import { conversationRuntimeDatabase } from "./conversation-runtime.js";
import { refreshAgentRun, type AgentRunDescriptor } from "./agent-run-monitor.js";
import type { AgentRunSummary, HarnessId, SessionSummary } from "./types.js";

export interface ConversationWork {
  engine: HarnessId;
  sessionId: string;
  summary: AgentRunSummary;
  descriptor?: AgentRunDescriptor;
}

function database(): ReturnType<typeof conversationRuntimeDatabase> {
  const db = conversationRuntimeDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_work (
    engine TEXT NOT NULL, session_id TEXT NOT NULL, run_id TEXT NOT NULL,
    payload TEXT NOT NULL, PRIMARY KEY (engine, session_id, run_id)
  )`);
  return db;
}

export function agentWorkActive(run: AgentRunSummary): boolean {
  return ["queued", "running"].includes(run.status)
    || run.tasks.some((task) => ["queued", "running"].includes(task.status));
}

/** Child lifecycle or confirmed loss of tracking ends work. A parent turn ending does not. */
export function recordConversationWork(work: ConversationWork): void {
  database().prepare(`INSERT INTO conversation_work VALUES (?, ?, ?, ?)
    ON CONFLICT(engine, session_id, run_id) DO UPDATE SET payload = excluded.payload`)
    .run(work.engine, work.sessionId, work.summary.runId, JSON.stringify(work));
}

export function listConversationWork(engine?: HarnessId, sessionId?: string): ConversationWork[] {
  const rows = engine !== undefined && sessionId !== undefined
    ? database().prepare("SELECT payload FROM conversation_work WHERE engine = ? AND session_id = ?").all(engine, sessionId)
    : database().prepare("SELECT payload FROM conversation_work").all();
  return rows.map((row) => JSON.parse(String(row.payload)) as ConversationWork);
}

export function conversationWorkActive(engine: HarnessId, sessionId: string): boolean {
  return listConversationWork(engine, sessionId).some((work) => agentWorkActive(work.summary));
}

function failActiveTasks(summary: AgentRunSummary, error: string): AgentRunSummary {
  return {
    ...summary,
    status: "failed",
    tasks: summary.tasks.map((task) => ["queued", "running"].includes(task.status) ? { ...task, status: "failed", error } : task),
  };
}

export function failUnobservedConversationWork(engine: HarnessId, sessionId: string, error: string): boolean {
  let changed = false;
  for (const work of listConversationWork(engine, sessionId)) {
    if (work.descriptor || !agentWorkActive(work.summary)) continue;
    recordConversationWork({ ...work, summary: failActiveTasks(work.summary, error) });
    changed = true;
  }
  return changed;
}

/**
 * A dashboard lives inside the agent process that spawned it, so after a restart one
 * that does not answer at all is gone for good: its runs would otherwise stay "running"
 * forever and keep every viewer polling. A dashboard that answers keeps reporting its runs.
 */
export async function retireUnreachableConversationWorkAfterRestart(): Promise<number> {
  let retired = 0;
  await Promise.all(listConversationWork().filter((work) => work.descriptor && agentWorkActive(work.summary)).map(async (work) => {
    let summary: AgentRunSummary;
    try {
      summary = await refreshAgentRun({ ...work.descriptor!, summary: work.summary });
    } catch (error) {
      summary = failActiveTasks(work.summary, `Joint Bob restarted and the run's dashboard is unreachable: ${error instanceof Error ? error.message : String(error)}`);
      retired += 1;
    }
    recordConversationWork({ ...work, summary });
  }));
  return retired;
}

export function failUnobservedConversationWorkAfterRestart(): number {
  const sessions = new Set(listConversationWork().filter((work) => work.engine === "claude").map((work) => work.sessionId));
  let failed = 0;
  for (const sessionId of sessions) {
    if (failUnobservedConversationWork("claude", sessionId, "Joint Bob restarted before reporting task completion")) failed += 1;
  }
  return failed;
}

let refreshInFlight: Promise<boolean> | undefined;

/** Viewer requests and maintenance must not race and overwrite a newer observation. */
export function refreshConversationWork(): Promise<boolean> {
  return refreshInFlight ??= refreshObservedWork().finally(() => { refreshInFlight = undefined; });
}

/** Persist descriptors independently of socket/session handles, including across node restarts. */
async function refreshObservedWork(): Promise<boolean> {
  let changed = false;
  await Promise.all(listConversationWork().filter((work) => work.descriptor && agentWorkActive(work.summary)).map(async (work) => {
    try {
      const summary = await refreshAgentRun({ ...work.descriptor!, summary: work.summary });
      if (JSON.stringify(summary) === JSON.stringify(work.summary)) return;
      recordConversationWork({ ...work, summary });
      changed = true;
    } catch {
      // An unreachable observer is not evidence that children finished.
    }
  }));
  return changed;
}

/** Run before review classification, including read-only children and mixed-harness families. */
export function applyConversationWork<T extends SessionSummary>(sessions: T[]): T[] {
  const result = sessions.map((session) => {
    const runs = new Map((session.agentRuns ?? []).map((run) => [run.runId, run]));
    for (const work of listConversationWork(session.harnessId, session.id)) runs.set(work.summary.runId, work.summary);
    const backgroundRunning = Boolean(session.backgroundRunning || [...runs.values()].some(agentWorkActive));
    return { ...session, ...(runs.size ? { agentRuns: [...runs.values()] } : {}),
      ...(backgroundRunning ? { backgroundRunning: true } : {}),
      running: Boolean(session.running || backgroundRunning) };
  });
  const byPath = new Map(result.map((session) => [session.path, session]));
  for (const session of result) {
    if (!session.running) continue;
    const seen = new Set<string>();
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
