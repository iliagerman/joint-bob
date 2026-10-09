import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { getClusterNode } from "./cluster.js";
import { mapWithConcurrency } from "./concurrency.js";
import { parseCompletedJsonl } from "./jsonl.js";
import { normalizeUsageRecords } from "./usage-import.js";
import { saveUsageEvents, saveUsageIngestFingerprint, upsertUsageInventory, usageIngestFingerprint } from "./usage-ledger.js";
const USAGE_REIMPORT_INTERVAL_MS = 6e4;
const fingerprints = /* @__PURE__ */ new Map();
const inFlight = /* @__PURE__ */ new Map();
function nativePath(session) {
  if (session.draft || !["pi", "claude"].includes(session.harnessId)) return null;
  return path.resolve(session.path.replace(/^(pi|claude):/, ""));
}
function parentFor(session, sessions) {
  if (!session.readOnly || !session.parentSessionPath) return void 0;
  const name = path.basename(session.parentSessionPath);
  return sessions.find((candidate) => candidate.path === session.parentSessionPath || path.basename(candidate.path) === name);
}
async function importSession(project, session, conversationId, origin) {
  const file = nativePath(session);
  if (!file) return session.draft ? "empty" : "unavailable";
  const key = `${project.id}:${conversationId}:${session.harnessId}:${session.id}:${file}`;
  const running = inFlight.get(key);
  if (running) return running;
  const pending = (async () => {
    let info;
    try {
      info = await stat(file);
    } catch (error) {
      if (error.code === "ENOENT") return "missing";
      throw error;
    }
    const fingerprint = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${project.id}:${conversationId}`;
    const cached = fingerprints.get(key) ?? usageIngestFingerprint(key);
    if (cached) fingerprints.set(key, cached);
    if (cached?.fingerprint === fingerprint) return cached.status;
    if (cached?.importedAt && Date.now() - cached.importedAt < USAGE_REIMPORT_INTERVAL_MS) return cached.status;
    let contents;
    try {
      contents = await readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return "missing";
      throw error;
    }
    const records = parseCompletedJsonl(contents);
    const { usageModelPricing } = await import("./pi-service.js");
    const events = normalizeUsageRecords(session.harnessId, session.id, records, {
      projectId: project.id,
      conversationId,
      createdAt: session.createdAt || project.createdAt
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
  try {
    return await pending;
  } finally {
    if (inFlight.get(key) === pending) inFlight.delete(key);
  }
}
async function ingestUsageSessions(project, sessions, records, concurrency = 4) {
  const lineage = new Map(records.map((record) => [`${record.engine}:${record.sessionId}`, record.conversationId ?? record.sessionId]));
  const origin = (await getClusterNode()).id;
  const ordered = [...sessions].sort((a, b) => (a.createdAt ?? project.createdAt).localeCompare(b.createdAt ?? project.createdAt));
  await mapWithConcurrency(ordered, concurrency, async (session) => {
    const parent = parentFor(session, sessions);
    const conversationId = parent ? lineage.get(`${parent.harnessId}:${parent.id}`) ?? parent.conversationId ?? parent.id : lineage.get(`${session.harnessId}:${session.id}`) ?? session.conversationId ?? session.id;
    const status = await importSession(project, session, conversationId, origin);
    upsertUsageInventory({
      projectId: project.id,
      conversationId,
      sessionId: session.id,
      engine: session.harnessId,
      title: parent?.title ?? session.title,
      classification: parent?.classification ?? session.classification ?? null,
      usageStatus: status
    });
    await new Promise((resolve) => setImmediate(resolve));
  });
}
const scheduled = /* @__PURE__ */ new Map();
let draining;
function scheduleUsageIngest(project, sessions, records) {
  scheduled.set(project.id, { project, sessions, records });
  if (!draining) startDrain();
}
function startDrain() {
  draining = (async () => {
    for (const [id, job] of scheduled) {
      scheduled.delete(id);
      try {
        await ingestUsageSessions(job.project, job.sessions, job.records, 1);
      } catch (error) {
        console.warn(`Usage import for project ${id} failed`, error);
      }
    }
  })().finally(() => {
    draining = void 0;
    if (scheduled.size) startDrain();
  });
}
async function usageIngestIdle() {
  while (draining) await draining;
}
export {
  USAGE_REIMPORT_INTERVAL_MS,
  ingestUsageSessions,
  scheduleUsageIngest,
  usageIngestIdle
};
