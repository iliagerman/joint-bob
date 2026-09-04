import { stat } from "node:fs/promises";
import path from "node:path";
import { sessionColorOverrides, sessionTitleOverrides } from "./names.js";
import { conversationDraftPath, listConversationRecords } from "./conversation-records.js";
import { listDiscoveredHarnesses, resolveHarnessForSessionPath } from "./harnesses/registry.js";
import type { HarnessAdapter, HarnessProject } from "./harnesses/contract.js";
import type { HarnessId, SessionSummary } from "./types.js";

export { defineHarness } from "./harnesses/contract.js";
export type { HarnessAdapter, HarnessProject } from "./harnesses/contract.js";

interface CatalogEntry {
  project: HarnessProject;
  harnessId: HarnessId;
  sessions: Promise<SessionSummary[]>;
  snapshot: Promise<Map<string, string>>;
}

function projectCacheKey(project: HarnessProject, harnessId: HarnessId): string {
  const paths = [project.path, project.macPath, ...(project.locations ?? []).map((location) => location.path), ...(project.additionalPaths ?? [])]
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(value));
  return `${project.id}:${harnessId}:${JSON.stringify([...new Set(paths)].sort())}`;
}

async function transcriptSnapshot(adapter: HarnessAdapter, project: HarnessProject): Promise<Map<string, string>> {
  const files = await adapter.sessions.files(project);
  const entries = await Promise.all(files.map(async (filePath): Promise<[string, string] | null> => {
    try {
      const info = await stat(filePath);
      return [path.resolve(filePath), `${info.mtimeMs}:${info.size}`];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }));
  return new Map(entries.filter((entry): entry is [string, string] => entry !== null));
}

function changedTranscriptFiles(previous: Map<string, string>, current: Map<string, string>): string[] {
  const files = new Set([...previous.keys(), ...current.keys()]);
  return [...files].filter((filePath) => previous.get(filePath) !== current.get(filePath));
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

  async refresh(projectId: string, changedFiles: string[]): Promise<void> {
    const entries = [...this.entries.entries()].filter(([, entry]) => entry.project.id === projectId);
    await Promise.all(entries.map(async ([key, entry]) => {
      const adapter = this.adapters.find((candidate) => candidate.id === entry.harnessId);
      if (!adapter) return;
      const ownedFiles = changedFiles.filter(adapter.paths.ownsTranscript);
      if (changedFiles.length && !ownedFiles.length) return;
      const previous = await entry.sessions;
      entry.sessions = adapter.sessions.refresh(entry.project, previous, ownedFiles);
      entry.snapshot = transcriptSnapshot(adapter, entry.project);
      try {
        await Promise.all([entry.sessions, entry.snapshot]);
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
    if (cached) {
      const [previous, current, sessions] = await Promise.all([cached.snapshot, transcriptSnapshot(adapter, project), cached.sessions]);
      const changedFiles = changedTranscriptFiles(previous, current);
      if (!changedFiles.length) return sessions;
      cached.sessions = adapter.sessions.refresh(project, sessions, changedFiles);
      cached.snapshot = Promise.resolve(current);
      try {
        return await cached.sessions;
      } catch (error) {
        this.entries.delete(key);
        throw error;
      }
    }
    const sessions = adapter.sessions.list(project);
    const snapshot = transcriptSnapshot(adapter, project);
    this.entries.set(key, { project, harnessId: adapter.id, sessions, snapshot });
    Promise.all([sessions, snapshot]).catch(() => this.entries.delete(key));
    return sessions;
  }
}

const adapters = listDiscoveredHarnesses();
const sessionCatalog = new HarnessSessionCatalog(adapters);

export function listHarnesses(): HarnessAdapter[] {
  return [...adapters];
}

export function harnessForSessionPath(sessionPath: string): HarnessAdapter {
  return resolveHarnessForSessionPath(adapters, sessionPath);
}

export function refreshHarnessSessions(projectId: string, changedFiles: string[]): Promise<void> {
  return sessionCatalog.refresh(projectId, changedFiles);
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
  const [overrides, colors, sessions, records] = await Promise.all([
    sessionTitleOverrides(),
    sessionColorOverrides(),
    sessionCatalog.list(project),
    listConversationRecords(project.id),
  ]);
  const transcriptKeys = new Set(sessions.map((session) => `${session.harnessId}:${session.id}`));
  for (const record of records) {
    if (transcriptKeys.has(`${record.engine}:${record.sessionId}`)) continue;
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
    });
  }
  const seen = new Set<string>();
  const pinnedPaths = new Set(pinnedSessionPaths);
  const pinnedIds = new Set(pinnedSessionIds);
  const isPinned = (session: SessionSummary): boolean => pinnedPaths.has(session.path) || pinnedIds.has(`${session.harnessId}:${session.id}`);
  const ordered = sessions
    .filter((session) => {
      if (!session.path || seen.has(session.path)) return false;
      seen.add(session.path);
      return true;
    })
    .map((session) => ({
      ...session,
      title: overrides[session.id] ?? session.title,
      ...(colors[session.id] ? { color: colors[session.id] } : {}),
    }))
    .sort((left, right) => (right.updatedAt ?? right.createdAt ?? "").localeCompare(left.updatedAt ?? left.createdAt ?? ""));

  return orderSessionFamilies([
    ...ordered.filter(isPinned),
    ...ordered.filter((session) => !isPinned(session)),
  ]).slice(0, 50);
}
