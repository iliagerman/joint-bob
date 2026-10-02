import { readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { isInternalSession } from "./internal-sessions.js";
import { sessionClassificationOverrides, sessionColorOverrides, sessionDoneOverrides, sessionTitleOverrides } from "./names.js";
import { conversationDraftPath, listConversationRecords } from "./conversation-records.js";
import { listDiscoveredHarnesses, resolveHarnessForSessionPath } from "./harnesses/registry.js";
import type { HarnessAdapter, HarnessProject } from "./harnesses/contract.js";
import type { HarnessModel, HarnessRuntime } from "./harnesses/runtime.js";
import type { HarnessId, SessionSummary } from "./types.js";
import { conversationUsage, usageTotals } from "./usage-ledger.js";
import { scheduleUsageIngest } from "./usage-ingest.js";

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
  return `${project.id}:${harnessId}:${project.historyDays ?? 0}:${JSON.stringify([...new Set(paths)].sort())}:${JSON.stringify(includedPaths)}:${JSON.stringify(includedIds)}:${JSON.stringify(recordIds)}`;
}

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

  async find(project: HarnessProject, harnessId: HarnessId, sessionPath: string, sessionId: string): Promise<SessionSummary | undefined> {
    const adapter = this.adapters.find((candidate) => candidate.id === harnessId);
    if (!adapter) throw new Error(`No harness registered for conversation engine: ${harnessId}`);
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
    const entries = [...this.entries.entries()].filter(([, entry]) => entry.project.id === projectId);
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
    if (cached) return cached.sessions;
    for (const [cachedKey, entry] of this.entries) {
      if (entry.project.id === project.id && entry.harnessId === adapter.id) this.entries.delete(cachedKey);
    }
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
  const pending = adapter.runtime();
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
  return sessionCatalog.refresh(projectId, changedFiles);
}

export function findHarnessSession(project: HarnessProject, harnessId: HarnessId, sessionPath: string, sessionId: string): Promise<SessionSummary | undefined> {
  return sessionCatalog.find(project, harnessId, sessionPath, sessionId);
}

export function clearHarnessSessionCache(projectId?: string): void {
  sessionCatalog.clear(projectId);
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
  for (const root of roots.slice(0, rootLimit)) append(root);
  return ordered;
}

/** Lists every registered harness through the shared catalog, then applies Joint Bob metadata. */
export async function listHarnessSessions(project: HarnessProject, pinnedSessionPaths: string[] = [], pinnedSessionIds: string[] = []): Promise<SessionSummary[]> {
  const [overrides, colors, classifications, doneMarks, initialSessions, records] = await Promise.all([
    sessionTitleOverrides(),
    sessionColorOverrides(),
    sessionClassificationOverrides(),
    sessionDoneOverrides(),
    sessionCatalog.list(project),
    listConversationRecords(project.id),
  ]);
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
  const filesByEngine = new Map(await Promise.all([...missingEngines].map(async (engine) => {
    const adapter = adapters.find((candidate) => candidate.id === engine);
    if (!adapter) throw new Error(`No harness registered for conversation engine: ${engine}`);
    const filesBySessionId = new Map<string, string>();
    for (const filePath of await adapter.sessions.files(project)) {
      const sessionId = adapter.paths.sessionId(filePath) ?? adapter.paths.sessionId(`${adapter.id}:${filePath}`);
      if (sessionId) filesBySessionId.set(sessionId, filePath);
    }
    return [engine, filesBySessionId] as const;
  })));
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
  for (const session of sessions) {
    const record = recordsBySession.get(`${session.harnessId}:${session.id}`);
    if (record?.taskId && !session.taskId) session.taskId = record.taskId;
    if (record?.cronTaskId) session.cronTaskId = record.cronTaskId;
  }
  // A harness can intentionally omit an unstarted transcript. Its record must
  // not turn that existing transcript back into a visible draft.
  const missingRecords = eligibleMissingRecords(sessions).filter((record) => !filesByEngine.get(record.engine)?.has(record.sessionId));
  for (const record of missingRecords) {
    const adapter = adapters.find((candidate) => candidate.id === record.engine);
    if (!adapter) throw new Error(`No harness registered for conversation engine: ${record.engine}`);
    // Fixer runs carry the internal ID prefix, so their records are filtered above without
    // opening transcripts. Reading them here reparsed every unlisted transcript per listing.
    sessions.push({
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
    });
  }
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
  // A harness switch continues one logical conversation: group its segments and
  // let the newest segment face the list. Single sessions group as themselves.
  const byConversation = new Map<string, Array<{ session: SessionSummary; segmentIndex: number }>>();
  for (const session of flat) {
    const record = recordsBySession.get(`${session.harnessId}:${session.id}`);
    const conversationId = record?.conversationId ?? session.id;
    byConversation.set(conversationId, [...(byConversation.get(conversationId) ?? []), { session, segmentIndex: record?.segmentIndex ?? 0 }]);
  }
  const ordered = [...byConversation.entries()].map(([conversationId, segments]) => {
    segments.sort((left, right) => left.segmentIndex - right.segmentIndex || (left.session.updatedAt ?? "").localeCompare(right.session.updatedAt ?? ""));
    const face = segments.at(-1)!.session;
    const firstLive = segments.map((segment) => segment.session).find((session) => !session.draft);
    const createdAt = segments.map((segment) => segment.session.createdAt).filter(Boolean).sort().at(0);
    const segmentViews = segments.length > 1
      ? segments.map((segment) => ({ engine: segment.session.harnessId, sessionId: segment.session.id, path: segment.session.path, ...(segment.session.draft ? { draft: true } : {}) }))
      : undefined;
    return {
      ...face,
      conversationId,
      usage: face.readOnly
        ? usageTotals({ projectIds: [project.id], projectId: project.id, sessionId: face.id })
        : conversationUsage(project.id, conversationId),
      ...(segments.some(({ session }) => session.cronTaskId) ? { cronTaskId: segments.find(({ session }) => session.cronTaskId)!.session.cronTaskId } : {}),
      ...(segmentViews ? { segments: segmentViews } : {}),
      // A switched conversation keeps the title of its first real segment; a fresh
      // segment's own title may be derived from the handoff envelope.
      title: overrides[conversationId] ?? (segments.length > 1 ? firstLive?.title ?? face.title : face.title),
      ...(colors[conversationId] ? { color: colors[conversationId] } : {}),
      ...(classifications[conversationId] ? { classification: classifications[conversationId] } : {}),
      ...(doneMarks[conversationId] ? { doneAt: doneMarks[conversationId] } : {}),
      ...(createdAt ? { createdAt } : {}),
    };
  }).sort((left, right) => (right.updatedAt ?? right.createdAt ?? "").localeCompare(left.updatedAt ?? left.createdAt ?? ""));

  // Closed-out conversations sink below the live ones so the 50-row cap spends its
  // room on work that is still moving. Pins still outrank everything.
  return orderSessionFamilies([
    ...ordered.filter(isPinned),
    ...ordered.filter((session) => !isPinned(session) && !session.doneAt),
    ...ordered.filter((session) => !isPinned(session) && session.doneAt),
  ], 50);
}
