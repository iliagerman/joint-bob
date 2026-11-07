import { readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { isInternalSession } from "./internal-sessions.js";
import { titleCase } from "./session-title.js";
import { sessionClassificationOverrides, sessionColorOverrides, sessionDoneOverrides, sessionFeedbackOverrides, sessionTitleOverrides } from "./names.js";
import { conversationDraftPath, listConversationRecords, listConversationSegments, parseConversationDraftPath, type ConversationRecord } from "./conversation-records.js";
import { listDiscoveredHarnesses, resolveHarnessForSessionPath } from "./harnesses/registry.js";
import type { HarnessAdapter, HarnessProject } from "./harnesses/contract.js";
import type { HarnessModel, HarnessRuntime } from "./harnesses/runtime.js";
import type { HarnessId, SessionSummary } from "./types.js";
import { conversationUsage, usageTotals } from "./usage-ledger.js";
import { scheduleUsageIngest } from "./usage-ingest.js";
import { sessionListingChanged } from "./session-listing-revisions.js";
import { autoRespondListing } from "./conversation-auto-respond.js";

export { defineHarness } from "./harnesses/contract.js";
export type { HarnessAdapter, HarnessProject } from "./harnesses/contract.js";

interface CatalogEntry {
  project: HarnessProject;
  harnessId: HarnessId;
  sessions: Promise<SessionSummary[]>;
}

function projectCacheKey(project: HarnessProject, harnessId: HarnessId): string {
  const paths = [project.path, project.macPath, ...(project.locations ?? []).map((location) => location.path), ...(project.additionalPaths ?? [])]
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(value));
  const includedPaths = [...new Set(project.includedSessionPaths ?? [])].sort();
  const includedIds = [...new Set(project.includedSessionIds ?? [])].sort();
  const recordIds = [...new Set(project.recordSessionIds ?? [])].sort();
  return `${project.id}:${harnessId}:${project.historyDays ?? 0}:${project.includeUnstarted ? 1 : 0}:${JSON.stringify([...new Set(paths)].sort())}:${JSON.stringify(includedPaths)}:${JSON.stringify(includedIds)}:${JSON.stringify(recordIds)}`;
}

/**
 * A project is listed in several scopes at once: a viewer's list with their pins and recents,
 * internal runs with none, a peer asking for every transcript, a chat being opened. Each scope
 * keeps its own answer. With one answer per project those callers evicted each other, and every
 * switch read the project's transcripts from disk again.
 */
const SCOPES_PER_PROJECT = 6;

export class HarnessSessionCatalog<TAdapters extends readonly HarnessAdapter[]> {
  private entries = new Map<string, CatalogEntry>();

  constructor(private readonly adapters: TAdapters) {
    const ids = adapters.map((adapter) => adapter.id);
    if (new Set(ids).size !== ids.length) throw new Error("Harness IDs must be unique");
  }

  async list(project: HarnessProject): Promise<SessionSummary[]> {
    const groups = await Promise.all(this.adapters.map((adapter) => this.listAdapter(adapter, project)));
    return groups.flat();
  }

  async find(requested: HarnessProject, harnessId: HarnessId, sessionPath: string, sessionId: string): Promise<SessionSummary | undefined> {
    const adapter = this.adapters.find((candidate) => candidate.id === harnessId);
    if (!adapter) throw new Error(`No harness registered for conversation engine: ${harnessId}`);
    // A transcript holding only the automatic start command is hidden from lists. It is still
    // the conversation being opened, or its socket could never reconnect before the first prompt.
    const project = { ...requested, includeUnstarted: true };
    // A node without the transcript lists the conversation as a draft and names it that way.
    if (parseConversationDraftPath(sessionPath)) return this.recoverById(adapter, project, sessionId);
    const prefix = `${harnessId}:`;
    let transcriptPath = path.resolve(sessionPath.startsWith(prefix) ? sessionPath.slice(prefix.length) : sessionPath);
    if (!adapter.paths.ownsTranscript(transcriptPath)) {
      if (!adapter.paths.localize) return undefined;
      try {
        const localized = adapter.paths.localize(sessionPath, os.homedir());
        transcriptPath = path.resolve(localized.startsWith(prefix) ? localized.slice(prefix.length) : localized);
      } catch {
        return undefined;
      }
      if (!adapter.paths.ownsTranscript(transcriptPath)) return this.recoverById(adapter, project, sessionId);
    }
    const sessions = await adapter.sessions.refresh(project, [], [transcriptPath]);
    return sessions.length ? sessions.find((session) => session.id === sessionId) : this.recoverById(adapter, project, sessionId);
  }

  private async recoverById(adapter: HarnessAdapter, project: HarnessProject, sessionId: string): Promise<SessionSummary | undefined> {
    let entries;
    try { entries = await readdir(adapter.sync.transcriptRoot(), { recursive: true, withFileTypes: true }); }
    catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
      throw error;
    }
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(entry.parentPath, entry.name))
      .filter((file) => {
        const sessionPath = adapter.paths.ownsSession(file) ? file : `${adapter.id}:${file}`;
        return adapter.paths.ownsTranscript(file) && adapter.paths.sessionId(sessionPath) === sessionId;
      });
    if (!files.length) return undefined;
    const sessions = await adapter.sessions.refresh(project, [], files);
    return sessions.find((session) => session.id === sessionId);
  }

  async refresh(projectId: string, changedFiles: string[]): Promise<void> {
    let entries = [...this.entries.entries()].filter(([, entry]) => entry.project.id === projectId);
    if (!changedFiles.length) {
      // A refresh that names no files rescans each scope it touches. Only the scope listed last
      // is rescanned now; the others are dropped and listed again when they are asked for.
      const latest = new Map(entries.map(([key, entry]) => [entry.harnessId, key]));
      for (const [key, entry] of entries) if (latest.get(entry.harnessId) !== key) this.entries.delete(key);
      entries = entries.filter(([key, entry]) => latest.get(entry.harnessId) === key);
    }
    await Promise.all(entries.map(async ([key, entry]) => {
      const adapter = this.adapters.find((candidate) => candidate.id === entry.harnessId);
      if (!adapter) return;
      const ownedFiles = changedFiles.filter(adapter.paths.ownsTranscript);
      if (changedFiles.length && !ownedFiles.length) return;
      try {
        entry.sessions = entry.sessions.then((sessions) => adapter.sessions.refresh(entry.project, sessions, ownedFiles));
        await entry.sessions;
      } catch (error) {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      }
    }));
  }

  clear(projectId?: string): void {
    if (!projectId) { this.entries.clear(); return; }
    for (const [key, entry] of this.entries) if (entry.project.id === projectId) this.entries.delete(key);
  }

  private async listAdapter(adapter: HarnessAdapter, project: HarnessProject): Promise<SessionSummary[]> {
    const key = projectCacheKey(project, adapter.id);
    const cached = this.entries.get(key);
    if (cached) {
      // Map order is use order, so the scope listed longest ago is the one evicted.
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.sessions;
    }
    const scopes = [...this.entries].filter(([, entry]) => entry.project.id === project.id && entry.harnessId === adapter.id);
    for (const [cachedKey] of scopes.slice(0, Math.max(0, scopes.length - SCOPES_PER_PROJECT + 1))) this.entries.delete(cachedKey);
    const sessions = adapter.sessions.list(project);
    const entry = { project, harnessId: adapter.id, sessions };
    this.entries.set(key, entry);
    sessions.catch(() => { if (this.entries.get(key) === entry) this.entries.delete(key); });
    return sessions;
  }
}

const adapters = listDiscoveredHarnesses();
const sessionCatalog = new HarnessSessionCatalog(adapters);

export function listHarnesses(): HarnessAdapter[] {
  return [...adapters];
}

export function getHarness(id: HarnessId): HarnessAdapter {
  const adapter = adapters.find((candidate) => candidate.id === id);
  if (!adapter) throw new Error(`No harness registered for conversation engine: ${id}`);
  return adapter;
}

const runtimePromises = new Map<HarnessId, Promise<HarnessRuntime>>();

export async function getHarnessRuntime(id: HarnessId): Promise<HarnessRuntime> {
  const existing = runtimePromises.get(id);
  if (existing) return existing;
  const adapter = getHarness(id);
  if (!adapter.runtime) throw new Error(`${adapter.label} does not support execution`);
  // Every model run a session starts passes the spend budgets first.
  const pending = adapter.runtime().then(async (runtime) => (await import("./budget-guard.js")).guardRuntime(runtime));
  runtimePromises.set(id, pending);
  try {
    return await pending;
  } catch (error) {
    runtimePromises.delete(id);
    throw error;
  }
}

/** The models a harness lists on this node, read from its harness file. */
export async function listHarnessModels(id: HarnessId): Promise<HarnessModel[]> {
  const adapter = getHarness(id);
  if (!adapter.models) throw new Error(`${adapter.label} does not list models`);
  return adapter.models();
}

export function harnessForProvider(provider: string): HarnessAdapter {
  const fixed = adapters.find((adapter) => adapter.configuration?.fixedProvider === provider);
  if (fixed) return fixed;
  const configurable = adapters.filter((adapter) => adapter.configuration && !adapter.configuration.fixedProvider);
  if (configurable.length === 1) return configurable[0];
  if (!configurable.length) throw new Error(`No harness registered for provider: ${provider}`);
  throw new Error(`Provider matches multiple configurable harnesses: ${provider}`);
}

export interface HarnessSyncFolder {
  id: string;
  label: string;
  path: string;
}

export function conversationSyncFolderId(harnessId: HarnessId): string {
  return `joint-bob-conversations-${harnessId}`;
}

function syncFolder(adapter: HarnessAdapter): HarnessSyncFolder {
  return { id: conversationSyncFolderId(adapter.id), label: `${adapter.label} conversations`, path: path.resolve(adapter.sync.transcriptRoot()) };
}

export function listHarnessSyncFolders(): HarnessSyncFolder[] {
  return adapters.map(syncFolder);
}

export function harnessForSessionPath(sessionPath: string): HarnessAdapter {
  return resolveHarnessForSessionPath(adapters, sessionPath);
}

export function refreshHarnessSessions(projectId: string, changedFiles: string[]): Promise<void> {
  // Marked once the catalog holds the change, so a listing computed meanwhile is not kept as current.
  return sessionCatalog.refresh(projectId, changedFiles).finally(() => sessionListingChanged(projectId));
}

export function findHarnessSession(project: HarnessProject, harnessId: HarnessId, sessionPath: string, sessionId: string): Promise<SessionSummary | undefined> {
  return sessionCatalog.find(project, harnessId, sessionPath, sessionId);
}

export function clearHarnessSessionCache(projectId?: string): void {
  sessionCatalog.clear(projectId);
  sessionListingChanged(projectId);
}

function transcriptName(sessionPath: string): string {
  return sessionPath.replace(/\\/g, "/").split("/").at(-1) ?? sessionPath;
}

export function orderSessionFamilies(sessions: SessionSummary[], rootLimit = Infinity): SessionSummary[] {
  const byPath = new Map(sessions.map((session) => [session.path, session]));
  const byName = new Map(sessions.map((session) => [transcriptName(session.path), session]));
  const parentOf = (session: SessionSummary): SessionSummary | undefined => {
    if (!session.parentSessionPath) return undefined;
    const parent = byPath.get(session.parentSessionPath) ?? byName.get(transcriptName(session.parentSessionPath));
    return parent?.path === session.path ? undefined : parent;
  };
  const children = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const parent = parentOf(session);
    if (parent) children.set(parent.path, [...(children.get(parent.path) ?? []), session]);
  }
  const roots: SessionSummary[] = [];
  for (const session of sessions) {
    let root = session;
    const ancestry = new Set([session.path]);
    let parent = parentOf(root);
    while (parent && !ancestry.has(parent.path)) {
      root = parent;
      ancestry.add(root.path);
      parent = parentOf(root);
    }
    if (!roots.some((candidate) => candidate.path === root.path)) roots.push(root);
  }
  const ordered: SessionSummary[] = [];
  const append = (session: SessionSummary): void => {
    if (ordered.includes(session)) return;
    ordered.push(session);
    for (const child of children.get(session.path) ?? []) append(child);
  };
  // Scheduled runs stay hidden until the reader asks for them, so they draw on their own
  // allowance; an hourly task would otherwise push every other conversation out of the list.
  const kept = { ordinary: 0, scheduled: 0 };
  for (const root of roots) {
    if (kept[root.cronTaskId || root.webhookHistory?.hidden ? "scheduled" : "ordinary"]++ < rootLimit) append(root);
  }
  return ordered;
}

function adapterFor(engine: HarnessId): HarnessAdapter {
  const adapter = adapters.find((candidate) => candidate.id === engine);
  if (!adapter) throw new Error(`No harness registered for conversation engine: ${engine}`);
  return adapter;
}

/** A project's transcripts of one harness by session id, from directory listings alone. */
async function transcriptFilesById(project: HarnessProject, engine: HarnessId): Promise<Map<string, string>> {
  const adapter = adapterFor(engine);
  const filesBySessionId = new Map<string, string>();
  for (const filePath of await adapter.sessions.files(project)) {
    const sessionId = adapter.paths.sessionId(filePath) ?? adapter.paths.sessionId(`${adapter.id}:${filePath}`);
    if (sessionId) filesBySessionId.set(sessionId, filePath);
  }
  return filesBySessionId;
}

/** Joint Bob's own fields for a transcript, kept on its conversation record. */
function applyConversationRecord(session: SessionSummary, record: ConversationRecord | undefined): void {
  if (record?.taskId && !session.taskId) session.taskId = record.taskId;
  if (record?.cronTaskId) session.cronTaskId = record.cronTaskId;
  if (record?.webhookHistory) session.webhookHistory = record.webhookHistory;
  if (record?.silentReviewFrom) session.silentReviewFrom = record.silentReviewFrom;
  if (record?.silentReviewUntil) session.silentReviewUntil = record.silentReviewUntil;
}

/** A recorded conversation with no transcript on this node lists as a draft. */
function recordedDraft(record: ConversationRecord, overrides: Record<string, string>): SessionSummary {
  const adapter = adapterFor(record.engine);
  return {
    id: record.sessionId,
    path: conversationDraftPath(record.engine, record.sessionId),
    harnessId: record.engine,
    agentId: record.engine,
    agentLabel: adapter.label,
    title: overrides[record.sessionId] ?? `New ${adapter.label} conversation`,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    draft: true,
    ...(record.taskId ? { taskId: record.taskId } : {}),
    ...(record.cronTaskId ? { cronTaskId: record.cronTaskId } : {}),
    ...(record.webhookHistory ? { webhookHistory: record.webhookHistory } : {}),
    ...(record.silentReviewFrom ? { silentReviewFrom: record.silentReviewFrom } : {}),
    ...(record.silentReviewUntil ? { silentReviewUntil: record.silentReviewUntil } : {}),
  };
}

interface ConversationLabels {
  overrides: Record<string, string>;
  colors: Awaited<ReturnType<typeof sessionColorOverrides>>;
  classifications: Record<string, string>;
  doneMarks: Record<string, string>;
  feedback: Awaited<ReturnType<typeof sessionFeedbackOverrides>>;
  autoResponders: Awaited<ReturnType<typeof autoRespondListing>>;
}

function conversationLabels(projectId: string): Promise<ConversationLabels> {
  return Promise.all([sessionTitleOverrides(), sessionColorOverrides(), sessionClassificationOverrides(), sessionDoneOverrides(), autoRespondListing(projectId), sessionFeedbackOverrides()])
    .then(([overrides, colors, classifications, doneMarks, autoResponders, feedback]) => ({ overrides, colors, classifications, doneMarks, autoResponders, feedback }));
}

/**
 * A harness switch continues one logical conversation: its segments group into one row,
 * faced by the newest segment. A single session groups as itself.
 */
function groupConversation(conversationId: string, segments: Array<{ session: SessionSummary; segmentIndex: number }>, labels: ConversationLabels): SessionSummary {
  const { overrides, colors, classifications, doneMarks, autoResponders } = labels;
  segments.sort((left, right) => left.segmentIndex - right.segmentIndex || (left.session.updatedAt ?? "").localeCompare(right.session.updatedAt ?? ""));
  const face = segments.at(-1)!.session;
  const webhookHistory = segments.map(({ session }) => session.webhookHistory).filter(item => item !== undefined)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const firstLive = segments.map((segment) => segment.session).find((session) => !session.draft);
  const createdAt = segments.map((segment) => segment.session.createdAt).filter(Boolean).sort().at(0);
  const segmentViews = segments.length > 1
    ? segments.map((segment) => ({ engine: segment.session.harnessId, sessionId: segment.session.id, path: segment.session.path, ...(segment.session.draft ? { draft: true } : {}) }))
    : undefined;
  return {
    ...face,
    conversationId,
    ...(segments.some(({ session }) => session.cronTaskId) ? { cronTaskId: segments.find(({ session }) => session.cronTaskId)!.session.cronTaskId } : {}),
    ...(webhookHistory ? { webhookHistory } : {}),
    ...(segmentViews ? { segments: segmentViews } : {}),
    // A switched conversation keeps the title of its first real segment; a fresh
    // segment's own title may be derived from the handoff envelope.
    title: overrides[conversationId] ?? titleCase(segments.length > 1 ? firstLive?.title ?? face.title : face.title),
    ...(colors[conversationId] ? { color: colors[conversationId] } : {}),
    ...(classifications[conversationId] ? { classification: classifications[conversationId] } : {}),
    ...(doneMarks[conversationId] ? { doneAt: doneMarks[conversationId] } : {}),
    ...(labels.feedback[conversationId] ? { feedback: labels.feedback[conversationId] } : {}),
    ...(autoResponders[conversationId] ? { autoRespond: autoResponders[conversationId] } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
}

/**
 * One switched conversation, found from its own records the way a listing would show it:
 * the opened segment is read from its path, every other segment from its transcript alone,
 * located by session id in the project's transcript folders. Opening one used to list the
 * whole project for this: 0.5 s on a quiet Mac, 22 s on a loaded one (2026-11-02). Returns
 * undefined when the opened segment has no transcript here, so the caller can still list.
 */
export async function findConversation(project: HarnessProject, opened: { engine: HarnessId; sessionPath: string; sessionId: string }, conversationId: string): Promise<SessionSummary | undefined> {
  const [labels, records, openedSession] = await Promise.all([
    conversationLabels(project.id),
    listConversationSegments(project.id, conversationId),
    sessionCatalog.find(project, opened.engine, opened.sessionPath, opened.sessionId),
  ]);
  if (!openedSession) return undefined;
  const isOpened = (record: ConversationRecord) => record.engine === opened.engine && record.sessionId === opened.sessionId;
  const others = records.filter((record) => !isOpened(record) && !isInternalSession(record.sessionId));
  const filesByEngine = new Map(await Promise.all([...new Set(others.map((record) => record.engine))]
    .map(async (engine) => [engine, await transcriptFilesById(project, engine)] as const)));
  const segments: Array<{ session: SessionSummary; segmentIndex: number }> = [];
  const seen = new Set<string>();
  for (const record of records) {
    let session: SessionSummary | undefined;
    if (isOpened(record)) session = openedSession;
    else if (isInternalSession(record.sessionId)) continue;
    else {
      const file = filesByEngine.get(record.engine)?.get(record.sessionId);
      // A transcript the harness leaves out (an unstarted one) stays out of the group, as in a listing.
      if (file) session = (await adapterFor(record.engine).sessions.refresh(project, [], [file])).find((candidate) => candidate.id === record.sessionId);
      else session = recordedDraft(record, labels.overrides);
    }
    if (!session || !session.path || seen.has(session.path) || isInternalSession(session.id, session.firstMessage) && !isOpened(record)) continue;
    seen.add(session.path);
    applyConversationRecord(session, record);
    segments.push({ session, segmentIndex: record.segmentIndex ?? 0 });
  }
  return groupConversation(conversationId, segments, labels);
}

/** Lists every registered harness through the shared catalog, then applies Joint Bob metadata. */
export async function listHarnessSessions(project: HarnessProject, pinnedSessionPaths: string[] = [], pinnedSessionIds: string[] = []): Promise<SessionSummary[]> {
  const [labels, initialSessions, records] = await Promise.all([
    conversationLabels(project.id),
    sessionCatalog.list(project),
    listConversationRecords(project.id),
  ]);
  const { overrides, classifications } = labels;
  let sessions = initialSessions;
  const pinnedFilesByAdapter = new Map<HarnessAdapter, string[]>();
  for (const sessionPath of pinnedSessionPaths) {
    const adapter = adapters.find((candidate) => candidate.paths.ownsTranscript(sessionPath))
      ?? adapters.find((candidate) => candidate.paths.ownsSession(sessionPath));
    if (!adapter || !adapter.paths.sessionId(sessionPath)) continue;
    const sessionFile = sessionPath.startsWith(`${adapter.id}:`) ? sessionPath.slice(adapter.id.length + 1) : sessionPath;
    const filePath = adapter.paths.ownsTranscript(sessionFile)
      ? sessionFile
      : adapter.paths.localize?.(sessionPath, os.homedir()) ?? sessionFile;
    if (!adapter.paths.ownsTranscript(filePath)) continue;
    pinnedFilesByAdapter.set(adapter, [...(pinnedFilesByAdapter.get(adapter) ?? []), filePath]);
  }
  for (const [adapter, paths] of pinnedFilesByAdapter) sessions = await adapter.sessions.refresh(project, sessions, paths);
  const pinnedPaths = new Set(pinnedSessionPaths);
  const pinnedIds = new Set(pinnedSessionIds);
  const recordsBySession = new Map(records.map((record) => [`${record.engine}:${record.sessionId}`, record]));
  const historyCutoff = project.historyDays ? Date.now() - project.historyDays * 24 * 60 * 60 * 1000 : 0;
  const eligibleMissingRecords = (current: SessionSummary[]) => {
    const transcriptKeys = new Set(current.map((session) => `${session.harnessId}:${session.id}`));
    return records.filter((record) => !isInternalSession(record.sessionId) && !transcriptKeys.has(`${record.engine}:${record.sessionId}`)
      && (!historyCutoff || Date.parse(record.updatedAt) >= historyCutoff || pinnedIds.has(`${record.engine}:${record.sessionId}`)));
  };
  const initialMissingRecords = eligibleMissingRecords(sessions);
  const missingEngines = new Set(initialMissingRecords.map((record) => record.engine));
  const filesByEngine = new Map(await Promise.all([...missingEngines].map(async (engine) => [engine, await transcriptFilesById(project, engine)] as const)));
  const discoveredRecords = initialMissingRecords.filter((record) => filesByEngine.get(record.engine)!.has(record.sessionId));
  const discovered = discoveredRecords.map((record) => filesByEngine.get(record.engine)!.get(record.sessionId)!);
  if (discovered.length) {
    await sessionCatalog.refresh(project.id, discovered);
    const transcriptProject = {
      ...project,
      includedSessionIds: [...new Set([...(project.includedSessionIds ?? []), ...discoveredRecords.map((record) => `${record.engine}:${record.sessionId}`)])],
      recordSessionIds: [...new Set([...(project.recordSessionIds ?? []), ...discoveredRecords.map((record) => `${record.engine}:${record.sessionId}`)])],
    };
    // Summarize only the recorded transcripts into this listing. Listing the widened
    // scope through the catalog replaced this scope's cached scan, so every listing
    // rescanned every transcript twice.
    const discoveredFilesByAdapter = new Map<HarnessAdapter, string[]>();
    for (const record of discoveredRecords) {
      const adapter = adapters.find((candidate) => candidate.id === record.engine)!;
      discoveredFilesByAdapter.set(adapter, [...(discoveredFilesByAdapter.get(adapter) ?? []), filesByEngine.get(record.engine)!.get(record.sessionId)!]);
    }
    for (const [adapter, files] of discoveredFilesByAdapter) sessions = await adapter.sessions.refresh(transcriptProject, sessions, files);
  }
  for (const session of sessions) applyConversationRecord(session, recordsBySession.get(`${session.harnessId}:${session.id}`));
  // A harness can intentionally omit an unstarted transcript. Its record must
  // not turn that existing transcript back into a visible draft.
  const missingRecords = eligibleMissingRecords(sessions).filter((record) => !filesByEngine.get(record.engine)?.has(record.sessionId));
  // Fixer runs carry the internal ID prefix, so their records are filtered above without
  // opening transcripts. Reading them here reparsed every unlisted transcript per listing.
  for (const record of missingRecords) sessions.push(recordedDraft(record, overrides));
  const seen = new Set<string>();
  const isPinned = (session: SessionSummary): boolean => pinnedPaths.has(session.path)
    || pinnedIds.has(`${session.harnessId}:${session.id}`)
    // A switched conversation is one pinning unit: its logical id, any legacy
    // segment pin, or any segment path keeps the group pinned.
    || pinnedIds.has(`${session.segments?.[0]?.engine ?? session.harnessId}:${session.conversationId ?? session.id}`)
    || Boolean(session.segments?.some((segment) => pinnedPaths.has(segment.path) || pinnedIds.has(`${segment.engine}:${segment.sessionId}`)));
  const flat = sessions.filter((session) => {
    if (isInternalSession(session.id, session.firstMessage) || !session.path || seen.has(session.path)) return false;
    seen.add(session.path);
    return true;
  }).map((session) => {
    const record = recordsBySession.get(`${session.harnessId}:${session.id}`);
    const logicalId = record?.conversationId ?? session.id;
    return classifications[logicalId] ? { ...session, classification: classifications[logicalId] } : session;
  });
  scheduleUsageIngest(project, flat, records);
  const byConversation = new Map<string, Array<{ session: SessionSummary; segmentIndex: number }>>();
  for (const session of flat) {
    const record = recordsBySession.get(`${session.harnessId}:${session.id}`);
    const conversationId = record?.conversationId ?? session.id;
    byConversation.set(conversationId, [...(byConversation.get(conversationId) ?? []), { session, segmentIndex: record?.segmentIndex ?? 0 }]);
  }
  const ordered = [...byConversation.entries()].map(([conversationId, segments]) => groupConversation(conversationId, segments, labels)).sort((left, right) => (right.updatedAt ?? right.createdAt ?? "").localeCompare(left.updatedAt ?? left.createdAt ?? ""));

  // Closed-out conversations sink below the live ones so the 50-row cap spends its
  // room on work that is still moving. Pins still outrank everything.
  // Usage is a ledger query per conversation, so only the rows that survive the cap get one.
  return orderSessionFamilies([
    ...ordered.filter(isPinned),
    ...ordered.filter((session) => !isPinned(session) && !session.doneAt),
    ...ordered.filter((session) => !isPinned(session) && session.doneAt),
  ], 50).map((session) => ({
    ...session,
    usage: session.readOnly
      ? usageTotals({ projectIds: [project.id], projectId: project.id, sessionId: session.id })
      : conversationUsage(project.id, session.conversationId ?? session.id),
  }));
}
