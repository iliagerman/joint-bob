import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { listDiscoveredHarnesses } from "./harnesses/registry.js";
import { sessionCwds, type SessionProjectPaths } from "./harnesses/shared-paths.js";
import type { ProjectRecord } from "./types.js";

const DEBOUNCE_MS = 750;
const RESCAN_MS = 15_000;
export type SessionChangeListener = (projectId: string, changedFiles: string[]) => void;
interface WatchedProject { paths: SessionProjectPaths; dirWatchers: Map<string, FSWatcher>; pendingFiles: Set<string>; needsFullRefresh: boolean; debounceTimer: NodeJS.Timeout | null; }

export function sessionWatchDirs(project: SessionProjectPaths): string[] {
  return [...new Set(listDiscoveredHarnesses().flatMap((adapter) => adapter.sync.watchDirs?.(project) ?? [adapter.sync.transcriptRoot()]))];
}
function missing(error: unknown): boolean { const code = (error as NodeJS.ErrnoException).code; return code === "ENOENT" || code === "ENOTDIR"; }

export class SessionWatcher {
  private projects = new Map<string, WatchedProject>();
  private ownerReads = new Map<string, Promise<string | null>>();
  private rescanTimer: NodeJS.Timeout;
  constructor(private listener: SessionChangeListener) { this.rescanTimer = setInterval(() => this.rescan(), RESCAN_MS); this.rescanTimer.unref(); }

  ensureProject(project: ProjectRecord): void {
    const watched = this.projects.get(project.id);
    const paths = { path: project.path, macPath: project.macPath, locations: project.locations, additionalPaths: "additionalPaths" in project ? project.additionalPaths as string[] | undefined : undefined };
    if (watched) watched.paths = paths;
    else this.projects.set(project.id, { paths, dirWatchers: new Map(), pendingFiles: new Set(), needsFullRefresh: false, debounceTimer: null });
    this.watchDirs(project.id);
  }
  removeProject(projectId: string): void { const project = this.projects.get(projectId); if (!project) return; if (project.debounceTimer) clearTimeout(project.debounceTimer); for (const watcher of project.dirWatchers.values()) watcher.close(); this.projects.delete(projectId); }
  close(): void { clearInterval(this.rescanTimer); for (const project of this.projects.values()) { if (project.debounceTimer) clearTimeout(project.debounceTimer); for (const watcher of project.dirWatchers.values()) watcher.close(); } this.projects.clear(); this.ownerReads.clear(); }

  private watchDirs(projectId: string): void {
    const project = this.projects.get(projectId); if (!project) return;
    const desired = new Set(sessionWatchDirs(project.paths));
    for (const [dir, watcher] of project.dirWatchers) if (!desired.has(dir)) { watcher.close(); project.dirWatchers.delete(dir); }
    for (const dir of desired) {
      if (project.dirWatchers.has(dir)) continue;
      try {
        const watcher = watch(dir, { recursive: true }, (_event, file) => {
          void this.handleEvent(projectId, dir, file).catch((error) => console.error(`Session watcher event failed for ${dir}:`, error));
        });
        watcher.unref();
        watcher.on("error", (error) => { watcher.close(); project.dirWatchers.delete(dir); if (!missing(error)) console.error(`Session watcher failed for ${dir}:`, error); });
        project.dirWatchers.set(dir, watcher);
        void this.handleEvent(projectId, dir, null).catch((error) => console.error(`Session watcher event failed for ${dir}:`, error));
      } catch (error) { if (!missing(error)) console.error(`Session watcher could not watch ${dir}:`, error); }
    }
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

  private async handleEvent(projectId: string, dir: string, fileName: string | Buffer | null): Promise<void> {
    const project = this.projects.get(projectId); if (!project) return;
    const name = typeof fileName === "string" ? fileName : Buffer.isBuffer(fileName) ? fileName.toString() : "";
    if (!name) project.needsFullRefresh = true;
    else {
      const file = path.join(dir, name);
      const adapter = listDiscoveredHarnesses().find((candidate) => candidate.paths.ownsTranscript(file));
      if (!adapter) return;
      const canonicalFile = adapter.paths.canonicalTranscript?.(file) ?? file;
      const cwd = await this.ownerCwd(adapter, canonicalFile);
      const current = this.projects.get(projectId);
      if (current !== project) return;
      if (cwd && !sessionCwds(current.paths).includes(cwd)) return;
      current.pendingFiles.add(canonicalFile);
    }
    if (this.projects.get(projectId) !== project || project.debounceTimer) return;
    project.debounceTimer = setTimeout(() => {
      project.debounceTimer = null;
      const files = project.needsFullRefresh ? [] : [...project.pendingFiles];
      project.needsFullRefresh = false;
      project.pendingFiles.clear();
      this.listener(projectId, files);
    }, DEBOUNCE_MS);
  }
}
