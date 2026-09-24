import os from "node:os";
import path from "node:path";
import { claudeConversationDefault } from "./claude.defaults.js";
import { defineHarness } from "./contract.js";
import { configuredRuntime, detectExecutable, localizeTranscript, type HarnessConfiguration } from "./runtime-configuration.js";

const configuration: HarnessConfiguration = {
  defaults: (home) => ({ executable: detectExecutable("claude"), configPath: path.join(home, ".claude"), sessionPath: path.join(home, ".claude/projects") }),
  fixedProvider: "claude",
  thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
  updateArgs: ["update"],
  restartFields: ["executable", "configPath"],
};
function claudeProjectsRoot(): string { return configuredRuntime("claude", configuration.defaults(os.homedir())).sessionPath; }
function projectCwds(project: import("../session-paths.js").SessionProjectPaths): string[] { return [...new Set([project.path, ...(project.macPath ? [project.macPath] : []), ...(project.locations ?? []).map((location) => location.path), ...(project.additionalPaths ?? [])].map((cwd) => path.resolve(cwd)))]; }
function projectDir(cwd: string): string { return path.join(claudeProjectsRoot(), cwd.replace(/^\//, "-").replace(/[\s_.\/]+/g, "-")); }
function watchDirs(project: import("../session-paths.js").SessionProjectPaths): string[] {
  return [...new Set([claudeProjectsRoot(), ...projectCwds(project).flatMap((cwd) => [cwd, path.dirname(cwd)]).map(projectDir)])];
}
function isWithin(filePath: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export default defineHarness({
  id: "claude", label: "Claude", order: 20, defaults: claudeConversationDefault, configuration,
  runtime: async () => (await import("./claude/runtime.js")).default,
  fork: async () => (await import("./claude/fork.js")).snapshotClaudeFork,
  resources: async () => (await import("./claude/resources.js")).default,
  paths: {
    newSession: "claude:new",
    ownsSession: (sessionPath) => sessionPath.startsWith("claude:") || sessionPath.startsWith("draft:claude:"),
    ownsTranscript: (filePath) => filePath.endsWith(".jsonl") && isWithin(filePath, claudeProjectsRoot()),
    sessionId: (sessionPath) => {
      if (!sessionPath.startsWith("claude:") || sessionPath.startsWith("draft:") || !sessionPath.endsWith(".jsonl")) return undefined;
      return path.basename(sessionPath.slice("claude:".length), ".jsonl") || undefined;
    },
    localize: (sessionPath, homePath) => localizeTranscript(sessionPath, homePath, ".claude", "claude:", "Claude"),
    transcriptFile: (sessionPath) => {
      const file = path.resolve(sessionPath.replace(/^claude:/, ""));
      if (!sessionPath.startsWith("claude:") || !file.endsWith(".jsonl") || !isWithin(file, claudeProjectsRoot())) throw new Error("Claude transcript is outside the configured transcript root");
      return file;
    },
  },
  sync: { transcriptRoot: claudeProjectsRoot, watchDirs },
  sessions: {
    files: async (project) => (await import("../claude-service.js")).claudeSessionFiles(project),
    list: async (project) => (await import("../claude-service.js")).listClaudeSessions(project),
    refresh: async (project, previous, changedFiles) => (await import("../claude-service.js")).refreshClaudeSessions(project, previous, changedFiles),
    loadMessages: async (_project, sessionPath) => (await import("../claude-service.js")).loadClaudeMessages(sessionPath),
  },
});
