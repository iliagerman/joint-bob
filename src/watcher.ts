import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { listDiscoveredHarnesses } from "./harnesses/registry.js";
import { sessionCwds, type SessionProjectPaths } from "./harnesses/shared-paths.js";
import type { ProjectRecord } from "./types.js";

const DEBOUNCE_MS = 750;
const RESCAN_MS = 15_000;
export type SessionChangeListener = (projectId: string, changedFiles: string[]) => void;
interface WatchedProject { paths: SessionProjectPaths; directories: Set<string>; pendingFiles: Map<string, ReturnType<typeof listDiscoveredHarnesses>[number]>; needsFullRefresh: boolean; debounceTimer: NodeJS.Timeout | null; }
interface SharedWatch { watcher: FSWatcher; projects: Set<string>; }

export function sessionWatchDirs(project: SessionProjectPaths): string[] {
  return [...new Set(listDiscoveredHarnesses().flatMap((adapter) => adapter.sync.watchDirs?.(project) ?? [adapter.sync.transcriptRoot()]))];
}
function missing(error: unknown): boolean { const code = (error as NodeJS.ErrnoException).code; return code === "ENOENT" || code === "ENOTDIR"; }

export class SessionWatcher {
  private projects = new Map<string, WatchedProject>();
  private directories = new Map<string, SharedWatch>();
  private ownerReads = new Map<string, Promise<string | null>>();
  private rescanTimer: NodeJS.Timeout;
  constructor(private listener: SessionChangeListener) { this.rescanTimer = setInterval(() => this.rescan(), RESCAN_MS); this.rescanTimer.unref(); }

  ensureProject(project: ProjectRecord): void {
    const watched = this.projects.get(project.id);
    const paths = { path: project.path, macPath: project.macPath, locations: project.locations, additionalPaths: "additionalPaths" in project ? project.additionalPaths as string[] | undefined : undefined };
    if (watched) watched.paths = paths;
    else this.projects.set(project.id, { paths, directories: new Set(), pendingFiles: new Map(), needsFullRefresh: false, debounceTimer: null });
    this.watchDirs(project.id);
  }
  removeProject(projectId: string): void {
    const project = this.projects.get(projectId); if (!project) return;
    if (project.debounceTimer) clearTimeout(project.debounceTimer);
    for (const dir of project.directories) this.unsubscribe(projectId, dir);
    this.projects.delete(projectId);
  }
  close(): void {
    clearInterval(this.rescanTimer);
    for (const projectId of this.projects.keys()) this.removeProject(projectId);
    this.ownerReads.clear();
  }
  private unsubscribe(projectId: string, dir: string): void {
    const shared = this.directories.get(dir)!;
    shared.projects.delete(projectId);
    if (!shared.projects.size) { shared.watcher.close(); this.directories.delete(dir); }
    this.projects.get(projectId)!.directories.delete(dir);
  }

  private watchDirs(projectId: string): void {
    const project = this.projects.get(projectId); if (!project) return;
    const desired = new Set(sessionWatchDirs(project.paths));
    for (const dir of project.directories) if (!desired.has(dir)) this.unsubscribe(projectId, dir);
    for (const dir of desired) {
      if (project.directories.has(dir)) continue;
      try {
        const shared = this.directories.get(dir) ?? this.openDirectory(dir);
        shared.projects.add(projectId);
        project.directories.add(dir);
        void this.handleEvent(projectId, dir, null).catch((error) => console.error(`Session watcher event failed for ${dir}:`, error));
      } catch (error) { if (!missing(error)) console.error(`Session watcher could not watch ${dir}:`, error); }
    }
  }
  private openDirectory(dir: string): SharedWatch {
    const projects = new Set<string>();
    const watcher = watch(dir, { recursive: true }, (_event, file) => {
      for (const projectId of projects) {
        void this.handleEvent(projectId, dir, file).catch((error) => console.error(`Session watcher event failed for ${dir}:`, error));
      }
    });
    watcher.unref();
    watcher.on("error", (error) => {
      for (const projectId of projects) this.unsubscribe(projectId, dir);
      if (!missing(error)) console.error(`Session watcher failed for ${dir}:`, error);
    });
    const shared = { watcher, projects };
    this.directories.set(dir, shared);
    return shared;
  }
  private rescan(): void { for (const projectId of this.projects.keys()) this.watchDirs(projectId); }

  private async ownerCwd(adapter: ReturnType<typeof listDiscoveredHarnesses>[number], filePath: string): Promise<string | null> {
    if (!adapter.sync.transcriptCwd) return null;
    const key = `${adapter.id}:${path.resolve(filePath)}`;
    const existing = this.ownerReads.get(key);
    if (existing) return existing;
    const reading = adapter.sync.transcriptCwd(filePath).catch((error) => {
      console.error(`Session watcher could not read transcript owner for ${filePath}:`, error);
      return null;
    }).finally(() => this.ownerReads.delete(key));
    this.ownerReads.set(key, reading);
    return reading;
  }

  private async flush(projectId: string, project: WatchedProject): Promise<void> {
    const fullRefresh = project.needsFullRefresh;
    const pending = [...project.pendingFiles];
    project.needsFullRefresh = false;
    project.pendingFiles.clear();
    // A create event can precede the first header write. Read ownership after debounce.
    const resolved = await Promise.all(pending.map(async ([file, adapter]) => {
      const cwd = await this.ownerCwd(adapter, file);
      return cwd && !sessionCwds(project.paths).includes(cwd) ? null : file;
    }));
    if (this.projects.get(projectId) !== project) return;
    const files = resolved.filter((file): file is string => file !== null);
    if (fullRefresh || files.length) this.listener(projectId, fullRefresh ? [] : files);
  }

  private async handleEvent(projectId: string, dir: string, fileName: string | Buffer | null): Promise<void> {
    const project = this.projects.get(projectId); if (!project) return;
    const name = typeof fileName === "string" ? fileName : Buffer.isBuffer(fileName) ? fileName.toString() : "";
    if (!name) project.needsFullRefresh = true;
    else {
      const file = path.join(dir, name);
      const adapter = listDiscoveredHarnesses().find((candidate) => candidate.paths.ownsTranscript(file));
      if (!adapter) return;
      const canonicalFile = adapter.paths.canonicalTranscript?.(file) ?? file;
      project.pendingFiles.set(canonicalFile, adapter);
    }
    if (this.projects.get(projectId) !== project || project.debounceTimer) return;
    project.debounceTimer = setTimeout(() => {
      project.debounceTimer = null;
      void this.flush(projectId, project).catch(error => console.error(`Session watcher refresh failed for ${projectId}:`, error));
    }, DEBOUNCE_MS);
  }
}
