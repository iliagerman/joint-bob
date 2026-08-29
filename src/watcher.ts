import { watch, type FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalPiTranscriptName, claudeProjectDirs, sessionCwds, type SessionProjectPaths } from "./session-paths.js";
import type { ProjectRecord } from "./types.js";

// Debounced fs.watch over the session directories (Pi + Claude) of each
// registered project. Syncthing writes temp files and renames them, so events
// are collected for a short window and only .jsonl files are reported.
const DEBOUNCE_MS = 750;
const RESCAN_MS = 15_000;

export type SessionChangeListener = (projectId: string, changedFiles: string[]) => void;

interface WatchedProject {
  paths: SessionProjectPaths;
  dirWatchers: Map<string, FSWatcher>;
  pendingFiles: Set<string>;
  debounceTimer: NodeJS.Timeout | null;
}

function piSessionDir(cwd: string): string {
  const resolved = path.resolve(cwd);
  const safePath = `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(os.homedir(), ".pi/agent/sessions", safePath);
}

function flatPiSessionDir(): string {
  return path.join(os.homedir(), ".pi/agent/sessions");
}

export function sessionWatchDirs(project: SessionProjectPaths): string[] {
  return [...new Set([...sessionCwds(project).map(piSessionDir), ...claudeProjectDirs(project)])];
}

export class SessionWatcher {
  private projects = new Map<string, WatchedProject>();
  private flatWatcher: FSWatcher | null = null;
  private rescanTimer: NodeJS.Timeout;

  constructor(private listener: SessionChangeListener) {
    this.rescanTimer = setInterval(() => this.rescan(), RESCAN_MS);
    this.rescanTimer.unref();
    this.watchFlatDir();
  }

  ensureProject(project: ProjectRecord): void {
    const watched = this.projects.get(project.id);
    const paths = { path: project.path, macPath: project.macPath };
    if (watched) watched.paths = paths;
    else this.projects.set(project.id, { paths, dirWatchers: new Map(), pendingFiles: new Set(), debounceTimer: null });
    this.watchDirs(project.id);
  }

  removeProject(projectId: string): void {
    const project = this.projects.get(projectId);
    if (!project) return;
    if (project.debounceTimer) clearTimeout(project.debounceTimer);
    for (const watcher of project.dirWatchers.values()) watcher.close();
    this.projects.delete(projectId);
  }

  close(): void {
    clearInterval(this.rescanTimer);
    this.flatWatcher?.close();
    this.flatWatcher = null;
    for (const project of this.projects.values()) {
      if (project.debounceTimer) clearTimeout(project.debounceTimer);
      for (const watcher of project.dirWatchers.values()) watcher.close();
    }
    this.projects.clear();
  }

  private watchDirs(projectId: string): void {
    const project = this.projects.get(projectId);
    if (!project) return;
    const desiredDirs = new Set(sessionWatchDirs(project.paths));
    for (const [dir, watcher] of project.dirWatchers) {
      if (desiredDirs.has(dir)) continue;
      watcher.close();
      project.dirWatchers.delete(dir);
    }
    for (const dir of desiredDirs) {
      if (project.dirWatchers.has(dir)) continue;
      try {
        const watcher = watch(dir, (_eventType, fileName) => this.handleEvent(projectId, dir, fileName));
        watcher.on("error", () => {
          watcher.close();
          project.dirWatchers.delete(dir);
        });
        project.dirWatchers.set(dir, watcher);
      } catch {
        // Directory does not exist yet (e.g. no sessions created); rescan picks it up later.
      }
    }
  }

  private watchFlatDir(): void {
    if (this.flatWatcher) return;
    const dir = flatPiSessionDir();
    try {
      const watcher = watch(dir, (_eventType, fileName) => {
        for (const projectId of this.projects.keys()) this.handleEvent(projectId, dir, fileName);
      });
      watcher.unref();
      watcher.on("error", () => {
        watcher.close();
        if (this.flatWatcher === watcher) this.flatWatcher = null;
      });
      this.flatWatcher = watcher;
    } catch {
      // Directory does not exist yet (e.g. no flat sessions created); rescan picks it up later.
    }
  }

  private rescan(): void {
    this.watchFlatDir();
    for (const projectId of this.projects.keys()) this.watchDirs(projectId);
  }

  private handleEvent(projectId: string, dir: string, fileName: string | Buffer | null): void {
    const project = this.projects.get(projectId);
    if (!project) return;
    const name = typeof fileName === "string" ? fileName : "";
    if (name && !name.endsWith(".jsonl")) return;
    if (name) project.pendingFiles.add(path.join(dir, canonicalPiTranscriptName(name)));
    if (project.debounceTimer) return;
    project.debounceTimer = setTimeout(() => {
      project.debounceTimer = null;
      const files = [...project.pendingFiles];
      project.pendingFiles.clear();
      this.listener(projectId, files);
    }, DEBOUNCE_MS);
  }
}
