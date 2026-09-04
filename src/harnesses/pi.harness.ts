import os from "node:os";
import path from "node:path";
import { createPiSession, listPiSessions, piSessionFiles, refreshPiSessions, simplifyMessages } from "../pi-service.js";
import { getSettings } from "../settings.js";
import { defineHarness } from "./contract.js";

function isWithin(filePath: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function piSessionsRoot(): string {
  return getSettings().pi.sessionPath || path.join(os.homedir(), ".pi/agent/sessions");
}

function hasHarnessPrefix(sessionPath: string): boolean {
  return /^[a-z][a-z0-9-]*:/.test(sessionPath);
}

export default defineHarness({
  id: "pi",
  label: "Pi",
  order: 10,
  paths: {
    newSession: "new",
    ownsSession: (sessionPath) => sessionPath === "new" || sessionPath.startsWith("draft:pi:") || !hasHarnessPrefix(sessionPath),
    ownsTranscript: (filePath) => filePath.endsWith(".jsonl") && isWithin(filePath, piSessionsRoot()),
  },
  sessions: {
    files: piSessionFiles,
    list: listPiSessions,
    refresh: refreshPiSessions,
    loadMessages: async (project, sessionPath) => {
      const handle = await createPiSession({ cwd: project.path, projectId: project.id, sessionPath });
      const messages = simplifyMessages(handle.session.messages as unknown[]);
      handle.dispose();
      return messages;
    },
  },
});
