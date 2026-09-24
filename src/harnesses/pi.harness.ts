import os from "node:os";
import path from "node:path";
import { piConversationDefault } from "./pi.defaults.js";
import { defineHarness } from "./contract.js";
import { configuredRuntime, detectExecutable, localizeTranscript, type HarnessConfiguration } from "./runtime-configuration.js";
import { canonicalPiTranscriptName, piSessionIdFromFileName } from "./pi/paths.js";
import { readTranscriptCwd } from "./shared-paths.js";

const configuration: HarnessConfiguration = {
  defaults: (home) => ({ executable: detectExecutable("pi"), configPath: path.join(home, ".pi/agent"), sessionPath: path.join(home, ".pi/agent/sessions") }),
  thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  updateArgs: ["update", "self", "--approve"],
  restartFields: ["configPath"],
};

function isWithin(filePath: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function piSessionsRoot(): string { return configuredRuntime("pi", configuration.defaults(os.homedir())).sessionPath; }
function hasHarnessPrefix(sessionPath: string): boolean { return /^[a-z][a-z0-9-]*:/.test(sessionPath); }
function projectCwds(project: import("../session-paths.js").SessionProjectPaths): string[] { return [...new Set([project.path, ...(project.macPath ? [project.macPath] : []), ...(project.locations ?? []).map((location) => location.path), ...(project.additionalPaths ?? [])].map((cwd) => path.resolve(cwd)))]; }
function sessionDir(cwd: string): string { const safe = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`; return path.join(piSessionsRoot(), safe); }

export default defineHarness({
  id: "pi", label: "Pi", order: 10, defaults: piConversationDefault, configuration,
  runtime: async () => (await import("./pi/runtime.js")).default,
  fork: async () => (await import("./pi/fork.js")).snapshotPiFork,
  resources: async () => (await import("./pi/resources.js")).default,
  paths: {
    newSession: "new",
    ownsSession: (sessionPath) => sessionPath === "new" || sessionPath.startsWith("draft:pi:") || !hasHarnessPrefix(sessionPath),
    ownsTranscript: (filePath) => filePath.endsWith(".jsonl") && isWithin(filePath, piSessionsRoot()),
    sessionId: (sessionPath) => {
      if (sessionPath === "new" || sessionPath.startsWith("draft:") || !sessionPath.endsWith(".jsonl")) return undefined;
      return piSessionIdFromFileName(path.basename(sessionPath)) || undefined;
    },
    localize: (sessionPath, homePath) => localizeTranscript(sessionPath, homePath, ".pi", "", "Pi"),
    canonicalTranscript: (filePath) => path.join(path.dirname(filePath), canonicalPiTranscriptName(path.basename(filePath))),
    transcriptFile: (sessionPath) => {
      const file = path.resolve(sessionPath);
      if (!sessionPath.endsWith(".jsonl") || !isWithin(file, piSessionsRoot()) || !path.extname(file).endsWith(".jsonl")) throw new Error("Pi transcript is outside the configured transcript root");
      return file;
    },
  },
  sync: {
    transcriptRoot: piSessionsRoot,
    watchDirs: (project) => [piSessionsRoot(), ...projectCwds(project).map(sessionDir)],
    transcriptCwd: (filePath) => readTranscriptCwd(filePath, "session"),
  },
  sessions: {
    files: async (project) => (await import("../pi-service.js")).piSessionFiles(project),
    list: async (project) => (await import("../pi-service.js")).listPiSessions(project),
    refresh: async (project, previous, changedFiles) => (await import("../pi-service.js")).refreshPiSessions(project, previous, changedFiles),
    loadMessages: async (_project, sessionPath) => (await import("../pi-service.js")).loadPiMessages(sessionPath),
    recover: async (sessionPath, cwd) => {
      const [{ capturePiRecoverySnapshot, recoverPiSessionDirectory }, { readdir }] = await Promise.all([import("./pi/recovery.js"), import("node:fs/promises")]);
      const snapshot = await capturePiRecoverySnapshot(sessionPath);
      const directory = path.dirname(sessionPath);
      const names = await readdir(directory);
      await recoverPiSessionDirectory(directory, names, snapshot, cwd);
    },
  },
});
