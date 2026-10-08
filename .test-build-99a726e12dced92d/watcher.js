import { watch } from "node:fs";
import path from "node:path";
import { listDiscoveredHarnesses } from "./harnesses/registry.js";
import { sessionCwds } from "./harnesses/shared-paths.js";
const DEBOUNCE_MS = 750;
const RESCAN_MS = 15e3;
function sessionWatchDirs(project) {
  return [...new Set(listDiscoveredHarnesses().flatMap((adapter) => adapter.sync.watchDirs?.(project) ?? [adapter.sync.transcriptRoot()]))];
}
function missing(error) {
  const code = error.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
class SessionWatcher {
  constructor(listener) {
    this.listener = listener;
    this.rescanTimer = setInterval(() => this.rescan(), RESCAN_MS);
    this.rescanTimer.unref();
  }
  listener;
  projects = /* @__PURE__ */ new Map();
  directories = /* @__PURE__ */ new Map();
  ownerReads = /* @__PURE__ */ new Map();
  rescanTimer;
  ensureProject(project) {
    const watched = this.projects.get(project.id);
    const paths = { path: project.path, macPath: project.macPath, locations: project.locations, additionalPaths: "additionalPaths" in project ? project.additionalPaths : void 0 };
    if (watched) watched.paths = paths;
    else this.projects.set(project.id, { paths, directories: /* @__PURE__ */ new Set(), pendingFiles: /* @__PURE__ */ new Map(), needsFullRefresh: false, debounceTimer: null });
    this.watchDirs(project.id);
  }
  removeProject(projectId) {
    const project = this.projects.get(projectId);
    if (!project) return;
    if (project.debounceTimer) clearTimeout(project.debounceTimer);
    for (const dir of project.directories) this.unsubscribe(projectId, dir);
    this.projects.delete(projectId);
  }
  close() {
    clearInterval(this.rescanTimer);
    for (const projectId of this.projects.keys()) this.removeProject(projectId);
    this.ownerReads.clear();
  }
  unsubscribe(projectId, dir) {
    const shared = this.directories.get(dir);
    shared.projects.delete(projectId);
    if (!shared.projects.size) {
      shared.watcher.close();
      this.directories.delete(dir);
    }
    this.projects.get(projectId).directories.delete(dir);
  }
  watchDirs(projectId) {
    const project = this.projects.get(projectId);
    if (!project) return;
    const desired = new Set(sessionWatchDirs(project.paths));
    for (const dir of project.directories) if (!desired.has(dir)) this.unsubscribe(projectId, dir);
    for (const dir of desired) {
      if (project.directories.has(dir)) continue;
      try {
        const shared = this.directories.get(dir) ?? this.openDirectory(dir);
        shared.projects.add(projectId);
        project.directories.add(dir);
        void this.handleEvent(projectId, dir, null).catch((error) => console.error(`Session watcher event failed for ${dir}:`, error));
      } catch (error) {
        if (!missing(error)) console.error(`Session watcher could not watch ${dir}:`, error);
      }
    }
  }
  openDirectory(dir) {
    const projects = /* @__PURE__ */ new Set();
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
  rescan() {
    for (const projectId of this.projects.keys()) this.watchDirs(projectId);
  }
  async ownerCwd(adapter, filePath) {
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
  async flush(projectId, project) {
    const fullRefresh = project.needsFullRefresh;
    const pending = [...project.pendingFiles];
    project.needsFullRefresh = false;
    project.pendingFiles.clear();
    const resolved = await Promise.all(pending.map(async ([file, adapter]) => {
      const cwd = await this.ownerCwd(adapter, file);
      return cwd && !sessionCwds(project.paths).includes(cwd) ? null : file;
    }));
    if (this.projects.get(projectId) !== project) return;
    const files = resolved.filter((file) => file !== null);
    if (fullRefresh || files.length) this.listener(projectId, fullRefresh ? [] : files);
  }
  async handleEvent(projectId, dir, fileName) {
    const project = this.projects.get(projectId);
    if (!project) return;
    const name = typeof fileName === "string" ? fileName : Buffer.isBuffer(fileName) ? fileName.toString() : "";
    if (!name) project.needsFullRefresh = true;
    else {
      const file = path.join(dir, name);
      const adapter = listDiscoveredHarnesses().find((candidate) => candidate.paths.ownsTranscript(file));
      if (!adapter) return;
      const canonicalFile = adapter.paths.canonicalTranscript?.(file) ?? file;
      project.pendingFiles.set(canonicalFile, adapter);
    }
    if (this.projects.get(projectId) !== project) return;
    if (project.debounceTimer) clearTimeout(project.debounceTimer);
    project.debounceTimer = setTimeout(() => {
      project.debounceTimer = null;
      void this.flush(projectId, project).catch((error) => console.error(`Session watcher refresh failed for ${projectId}:`, error));
    }, DEBOUNCE_MS);
  }
}
export {
  SessionWatcher,
  sessionWatchDirs
};
