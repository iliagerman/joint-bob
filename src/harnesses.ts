import path from "node:path";
import { sessionClassificationOverrides, sessionColorOverrides, sessionTitleOverrides } from "./names.js";
import { conversationDraftPath, listConversationRecords } from "./conversation-records.js";
import { listDiscoveredHarnesses, resolveHarnessForSessionPath } from "./harnesses/registry.js";
import type { HarnessAdapter, HarnessProject } from "./harnesses/contract.js";
import type { HarnessRuntime } from "./harnesses/runtime.js";
import type { HarnessId, SessionSummary } from "./types.js";

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
  return `${project.id}:${harnessId}:${project.historyDays ?? 0}:${JSON.stringify([...new Set(paths)].sort())}:${JSON.stringify(includedPaths)}:${JSON.stringify(includedIds)}`;
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
    const transcriptPath = path.resolve(sessionPath.startsWith(prefix) ? sessionPath.slice(prefix.length) : sessionPath);
    if (!adapter.paths.ownsTranscript(transcriptPath)) return undefined;
    const sessions = await adapter.sessions.refresh(project, [], [transcriptPath]);
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
        this.entries.delete(key);
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
    this.entries.set(key, { project, harnessId: adapter.id, sessions });
    sessions.catch(() => this.entries.delete(key));
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

export function harnessSyncFolderForSessionPath(sessionPath: string): HarnessSyncFolder {
  return syncFolder(harnessForSessionPath(sessionPath));
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

export function orderSessionFamilies(sessions: SessionSummary[]): SessionSummary[] {
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
  for (const root of roots) append(root);
  return ordered;
}

/** Lists every registered harness through the shared catalog, then applies Joint Bob metadata. */
export async function listHarnessSessions(project: HarnessProject, pinnedSessionPaths: string[] = [], pinnedSessionIds: string[] = []): Promise<SessionSummary[]> {
  const [overrides, colors, classifications, initialSessions, records] = await Promise.all([
    sessionTitleOverrides(),
    sessionColorOverrides(),
    sessionClassificationOverrides(),
    sessionCatalog.list(project),
    listConversationRecords(project.id),
  ]);
  let sessions = initialSessions;
  const pinnedPaths = new Set(pinnedSessionPaths);
  const pinnedIds = new Set(pinnedSessionIds);
  const recordsBySession = new Map(records.map((record) => [`${record.engine}:${record.sessionId}`, record]));
  const historyCutoff = project.historyDays ? Date.now() - project.historyDays * 24 * 60 * 60 * 1000 : 0;
  const eligibleMissingRecords = (current: SessionSummary[]) => {
    const transcriptKeys = new Set(current.map((session) => `${session.harnessId}:${session.id}`));
    return records.filter((record) => !transcriptKeys.has(`${record.engine}:${record.sessionId}`)
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
  const discovered = initialMissingRecords.flatMap((record) => {
    const transcript = filesByEngine.get(record.engine)!.get(record.sessionId);
    return transcript ? [transcript] : [];
  });
  if (discovered.length) {
    await sessionCatalog.refresh(project.id, discovered);
    sessions = await sessionCatalog.list(project);
  }
  for (const session of sessions) {
    const record = recordsBySession.get(`${session.harnessId}:${session.id}`);
    if (record?.taskId && !session.taskId) session.taskId = record.taskId;
    if (record?.cronTaskId) session.cronTaskId = record.cronTaskId;
  }
  const missingRecords = eligibleMissingRecords(sessions);
  for (const record of missingRecords) {
    const adapter = adapters.find((candidate) => candidate.id === record.engine);
    if (!adapter) throw new Error(`No harness registered for conversation engine: ${record.engine}`);
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
    if (!session.path || seen.has(session.path)) return false;
    seen.add(session.path);
    return true;
  });
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
      ...(segments.some(({ session }) => session.cronTaskId) ? { cronTaskId: segments.find(({ session }) => session.cronTaskId)!.session.cronTaskId } : {}),
      ...(segmentViews ? { segments: segmentViews } : {}),
      // A switched conversation keeps the title of its first real segment; a fresh
      // segment's own title may be derived from the handoff envelope.
      title: overrides[conversationId] ?? (segments.length > 1 ? firstLive?.title ?? face.title : face.title),
      ...(colors[conversationId] ? { color: colors[conversationId] } : {}),
      ...(classifications[conversationId] ? { classification: classifications[conversationId] } : {}),
      ...(createdAt ? { createdAt } : {}),
    };
  }).sort((left, right) => (right.updatedAt ?? right.createdAt ?? "").localeCompare(left.updatedAt ?? left.createdAt ?? ""));

  return orderSessionFamilies([
    ...ordered.filter(isPinned),
    ...ordered.filter((session) => !isPinned(session)),
  ]).slice(0, 50);
}
