import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { getClusterNode } from "./cluster.js";
import { mapWithConcurrency } from "./concurrency.js";
import type { ConversationRecord } from "./conversation-records.js";
import { parseCompletedJsonl } from "./jsonl.js";
import type { ProjectRecord, SessionSummary } from "./types.js";
import { normalizeUsageRecords } from "./usage-import.js";
import { saveUsageEvents, saveUsageIngestFingerprint, upsertUsageInventory, usageIngestFingerprint } from "./usage-ledger.js";

/**
 * A transcript being written changes on every turn, and importing it re-reads the whole file,
 * so a changed file is re-imported at most once per interval.
 */
export const USAGE_REIMPORT_INTERVAL_MS = 60_000;
const fingerprints = new Map<string, { fingerprint: string; status: string; importedAt?: number }>();
const inFlight = new Map<string, Promise<string>>();

function nativePath(session: SessionSummary): string | null {
  if (session.draft || !["pi", "claude"].includes(session.harnessId)) return null;
  return path.resolve(session.path.replace(/^(pi|claude):/, ""));
}

function parentFor(session: SessionSummary, sessions: SessionSummary[]): SessionSummary | undefined {
  if (!session.readOnly || !session.parentSessionPath) return undefined;
  const name = path.basename(session.parentSessionPath);
  return sessions.find((candidate) => candidate.path === session.parentSessionPath || path.basename(candidate.path) === name);
}

async function importSession(project: ProjectRecord, session: SessionSummary, conversationId: string, origin: string): Promise<string> {
  const file = nativePath(session);
  if (!file) return session.draft ? "empty" : "unavailable";
  const key = `${project.id}:${conversationId}:${session.harnessId}:${session.id}:${file}`;
  const running = inFlight.get(key);
  if (running) return running;
  const pending = (async () => {
    let info;
    try { info = await stat(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
    const fingerprint = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${project.id}:${conversationId}`;
    // The persisted fingerprint keeps a restart from re-reading every transcript on disk.
    const cached: { fingerprint: string; status: string; importedAt?: number } | undefined = fingerprints.get(key) ?? usageIngestFingerprint(key);
    if (cached) fingerprints.set(key, cached);
    if (cached?.fingerprint === fingerprint) return cached.status;
    if (cached?.importedAt && Date.now() - cached.importedAt < USAGE_REIMPORT_INTERVAL_MS) return cached.status;
    let contents: string;
    try { contents = await readFile(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
    const records = parseCompletedJsonl(contents);
    const { usageModelPricing } = await import("./pi-service.js");
    const events = normalizeUsageRecords(session.harnessId, session.id, records, {
      projectId: project.id, conversationId, createdAt: session.createdAt || project.createdAt,
    }, (provider, modelId) => {
      const pricing = usageModelPricing(provider, modelId);
      return pricing?.rates ? { rates: pricing.rates, pricing } : null;
    });
    saveUsageEvents(events, origin);
    const status = events.some((event) => event.usageStatus === "missing") ? "missing" : "reported";
    fingerprints.set(key, { fingerprint, status, importedAt: Date.now() });
    saveUsageIngestFingerprint(key, fingerprint, status);
    return status;
  })();
  inFlight.set(key, pending);
  try { return await pending; }
  finally { if (inFlight.get(key) === pending) inFlight.delete(key); }
}

export async function ingestUsageSessions(project: ProjectRecord, sessions: SessionSummary[], records: ConversationRecord[]): Promise<void> {
  const lineage = new Map(records.map((record) => [`${record.engine}:${record.sessionId}`, record.conversationId ?? record.sessionId]));
  const origin = (await getClusterNode()).id;
  const ordered = [...sessions].sort((a, b) => (a.createdAt ?? project.createdAt).localeCompare(b.createdAt ?? project.createdAt));
  await mapWithConcurrency(ordered, 4, async (session) => {
    const parent = parentFor(session, sessions);
    const conversationId = parent
      ? lineage.get(`${parent.harnessId}:${parent.id}`) ?? parent.conversationId ?? parent.id
      : lineage.get(`${session.harnessId}:${session.id}`) ?? session.conversationId ?? session.id;
    const status = await importSession(project, session, conversationId, origin);
    upsertUsageInventory({
      projectId: project.id, conversationId, sessionId: session.id, engine: session.harnessId,
      title: parent?.title ?? session.title, classification: parent?.classification ?? session.classification ?? null, usageStatus: status,
    });
  });
}
