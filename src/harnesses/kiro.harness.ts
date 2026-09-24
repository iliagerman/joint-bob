import os from "node:os";
import path from "node:path";
import { defineHarness } from "./contract.js";
import { kiroConversationDefault } from "./kiro.defaults.js";
import { configuredRuntime, detectExecutable, localizeTranscript, type HarnessConfiguration } from "./runtime-configuration.js";
import { readTranscriptCwd } from "./shared-paths.js";

const configuration: HarnessConfiguration = { defaults: (home) => ({ executable: detectExecutable("kiro-cli"), configPath: path.join(home, ".kiro"), sessionPath: path.join(home, ".kiro/sessions") }), fixedProvider: "kiro", thinkingLevels: ["low", "medium", "high", "xhigh", "max"], updateArgs: ["update"], restartFields: ["executable", "configPath"] };
function root(): string { return configuredRuntime("kiro", configuration.defaults(os.homedir())).sessionPath; }
function within(file: string): boolean { const relative = path.relative(path.join(root(), "joint-bob"), path.resolve(file)); return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative); }
export default defineHarness({
  id: "kiro", label: "Kiro", order: 30, defaults: kiroConversationDefault, configuration,
  runtime: async () => (await import("./kiro/runtime.js")).default,
  fork: async () => (await import("./kiro/fork.js")).snapshotKiroFork,
  resources: async () => (await import("./kiro/resources.js")).default,
  paths: { newSession: "kiro:new", ownsSession: (value) => value.startsWith("kiro:") || value.startsWith("draft:kiro:"), ownsTranscript: (file) => file.endsWith(".jsonl") && within(file), sessionId: (value) => value === "kiro:new" || value.startsWith("draft:") ? undefined : path.basename(value.replace(/^kiro:/, ""), ".jsonl") || undefined, localize: (value, home) => localizeTranscript(value, home, ".kiro", "kiro:", "Kiro"), transcriptFile: (value) => { const file = path.resolve(value.replace(/^kiro:/, "")); if (!value.startsWith("kiro:") || !file.endsWith(".jsonl") || !within(file)) throw new Error("Kiro transcript is outside the configured transcript root"); return file; } },
  sync: {
    transcriptRoot: root,
    watchDirs: () => [root(), path.join(root(), "joint-bob")],
    transcriptCwd: (filePath) => readTranscriptCwd(filePath, "joint-bob-kiro"),
  },
  sessions: { files: async (project) => (await import("./kiro/storage.js")).listKiroSessionFiles(project), list: async (project) => (await import("./kiro/storage.js")).listKiroSessions(project), refresh: async (project, previous, changed) => (await import("./kiro/storage.js")).refreshKiroSessions(project, previous, changed), loadMessages: async (project, value) => (await import("./kiro/storage.js")).loadKiroMessages(project, value) },
});
