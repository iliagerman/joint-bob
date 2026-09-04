import path from "node:path";
import { claudeProjectsRoot, claudeSessionFiles, listClaudeSessions, loadClaudeMessages, refreshClaudeSessions } from "../claude-service.js";
import { defineHarness } from "./contract.js";

function isWithin(filePath: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export default defineHarness({
  id: "claude",
  label: "Claude",
  order: 20,
  paths: {
    newSession: "claude:new",
    ownsSession: (sessionPath) => sessionPath.startsWith("claude:") || sessionPath.startsWith("draft:claude:"),
    ownsTranscript: (filePath) => filePath.endsWith(".jsonl") && isWithin(filePath, claudeProjectsRoot()),
  },
  sessions: {
    files: claudeSessionFiles,
    list: listClaudeSessions,
    refresh: refreshClaudeSessions,
    loadMessages: async (_project, sessionPath) => loadClaudeMessages(sessionPath),
  },
});
