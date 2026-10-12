import os from "node:os";
import { runtimeHome } from "../account-runtime.js";
import path from "node:path";
import { claudeConversationDefault } from "./claude.defaults.js";
import { defineHarness } from "./contract.js";
import { configuredRuntime, detectExecutable, localizeTranscript, type HarnessConfiguration } from "./runtime-configuration.js";

const configuration: HarnessConfiguration = {
  defaults: (home) => ({ executable: detectExecutable("claude"), configPath: path.join(home, ".claude"), sessionPath: path.join(home, ".claude/projects") }),
  fixedProvider: "claude",
  thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
  update: { type: "npm", packageName: "@anthropic-ai/claude-code", binaryName: "claude" },
  restartFields: ["executable", "configPath"],
};
function claudeProjectsRoot(): string { return configuredRuntime("claude", configuration.defaults(runtimeHome())).sessionPath; }
function projectCwds(project: import("../session-paths.js").SessionProjectPaths): string[] { return [...new Set([project.path, ...(project.macPath ? [project.macPath] : []), ...(project.locations ?? []).map((location) => location.path), ...(project.additionalPaths ?? [])].map((cwd) => path.resolve(cwd)))]; }
function projectDir(cwd: string): string { return path.join(claudeProjectsRoot(), cwd.replace(/^\//, "-").replace(/[\s_.\/]+/g, "-")); }
/** The folders a project's conversations are listed from: one per working directory and its parent. */
function projectDirs(project: import("../session-paths.js").SessionProjectPaths): string[] {
  return [...new Set(projectCwds(project).flatMap((cwd) => [cwd, path.dirname(cwd)]).map(projectDir))];
}
function watchDirs(project: import("../session-paths.js").SessionProjectPaths): string[] {
  return [...new Set([claudeProjectsRoot(), ...projectDirs(project)])];
}
function isWithin(filePath: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export default defineHarness({
  id: "claude", label: "Claude", order: 20, defaults: claudeConversationDefault, configuration,
  runtime: async () => (await import("./claude/runtime.js")).default,
  models: async () => (await import("./claude/models.js")).claudeModels(),
  fork: async () => (await import("./claude/fork.js")).snapshotClaudeFork,
  resources: async () => (await import("./claude/resources.js")).default,
  paths: {
    newSession: "claude:new",
    ownsSession: (sessionPath) => sessionPath.startsWith("claude:") || sessionPath.startsWith("draft:claude:"),
    ownsTranscript: (filePath) => filePath.endsWith(".jsonl") && isWithin(filePath, claudeProjectsRoot()),
    sessionId: (sessionPath) => {
      if (!sessionPath.startsWith("claude:") || sessionPath.startsWith("draft:") || !sessionPath.endsWith(".jsonl")) return undefined;
      const filePath = sessionPath.slice("claude:".length);
      const id = path.basename(filePath, ".jsonl");
      return path.basename(path.dirname(filePath)) === "subagents"
        ? `${path.basename(path.dirname(path.dirname(filePath)))}/${id}`
        : id || undefined;
    },
    localize: (sessionPath, homePath) => localizeTranscript(sessionPath, homePath, ".claude", "claude:", "Claude"),
    transcriptFile: (sessionPath) => {
      const file = path.resolve(sessionPath.replace(/^claude:/, ""));
      if (!sessionPath.startsWith("claude:") || !file.endsWith(".jsonl") || !isWithin(file, claudeProjectsRoot())) throw new Error("Claude transcript is outside the configured transcript root");
      return file;
    },
  },
  sync: {
    transcriptRoot: claudeProjectsRoot,
    watchDirs,
    transcriptBelongs: (project, filePath) => projectDirs(project).some((dir) => isWithin(filePath, dir)),
    // Claude files tool results under the user role; a queued prompt is a person's too.
    sentByPerson: (entry) => {
      if (entry.type === "queue-operation") return true;
      if (entry.type !== "user") return false;
      const content = (entry.message as { content?: unknown } | undefined)?.content;
      return !Array.isArray(content) || content.some((block) => (block as { type?: unknown } | null)?.type !== "tool_result");
    },
  },
  sessions: {
    files: async (project) => (await import("../claude-service.js")).claudeSessionFiles(project),
    list: async (project) => (await import("../claude-service.js")).listClaudeSessions(project),
    refresh: async (project, previous, changedFiles) => (await import("../claude-service.js")).refreshClaudeSessions(project, previous, changedFiles),
    loadMessages: async (_project, sessionPath) => (await import("../claude-service.js")).loadClaudeMessages(sessionPath),
  },
});
