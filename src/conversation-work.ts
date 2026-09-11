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

/** Only explicit child lifecycle observations complete work. A parent turn ending does not. */
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
      const summary = await refreshAgentRun(work.descriptor!);
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
    return { ...session, ...(runs.size ? { agentRuns: [...runs.values()] } : {}),
      running: Boolean(session.running || [...runs.values()].some(agentWorkActive)) };
  });
  const byPath = new Map(result.map((session) => [session.path, session]));
  for (const session of result) {
    if (!session.running) continue;
    const seen = new Set<string>();
    let parent = session.parentSessionPath && byPath.get(session.parentSessionPath);
    while (parent && !seen.has(parent.path)) {
      seen.add(parent.path);
      parent.running = true;
      parent = parent.parentSessionPath && byPath.get(parent.parentSessionPath);
    }
  }
  return result;
}
