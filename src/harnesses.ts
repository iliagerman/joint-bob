import { sessionTitleOverrides } from "./names.js";
import { createPiSession, listPiSessions, simplifyMessages } from "./pi-service.js";
import { listClaudeSessions, loadClaudeMessages } from "./claude-service.js";
import type { ChatMessage, HarnessId, ProjectRecord, SessionSummary } from "./types.js";

export interface HarnessProject extends ProjectRecord {
  additionalPaths?: string[];
}

export interface HarnessAdapter {
  id: HarnessId;
  label: string;
  newSessionPath: string;
  ownsSessionPath: (sessionPath: string) => boolean;
  listSessions: (project: HarnessProject) => Promise<SessionSummary[]>;
  loadMessages: (project: ProjectRecord, sessionPath: string) => Promise<ChatMessage[]>;
}

const adapters: HarnessAdapter[] = [
  {
    id: "pi",
    label: "Pi",
    newSessionPath: "new",
    ownsSessionPath: (sessionPath) => !sessionPath.startsWith("claude:"),
    listSessions: listPiSessions,
    loadMessages: async (project, sessionPath) => {
      const handle = await createPiSession({ cwd: project.path, projectId: project.id, sessionPath });
      const messages = simplifyMessages(handle.session.messages as unknown[]);
      handle.dispose();
      return messages;
    },
  },
  {
    id: "claude",
    label: "Claude",
    newSessionPath: "claude:new",
    ownsSessionPath: (sessionPath) => sessionPath.startsWith("claude:"),
    listSessions: listClaudeSessions,
    loadMessages: async (_project, sessionPath) => loadClaudeMessages(sessionPath),
  },
];

export function listHarnesses(): HarnessAdapter[] {
  return [...adapters];
}

export function harnessForSessionPath(sessionPath: string): HarnessAdapter {
  const harness = adapters.find((candidate) => candidate.ownsSessionPath(sessionPath));
  if (!harness) throw new Error(`No harness owns session path: ${sessionPath}`);
  return harness;
}

/**
 * The recency cap keeps the list cheap to render. Pinned conversations are hoisted
 * above it first so a deliberately kept conversation can never fall off the end.
 */
export async function listHarnessSessions(project: HarnessProject, pinnedSessionPaths: string[] = []): Promise<SessionSummary[]> {
  const overrides = await sessionTitleOverrides();
  const sessions = (await Promise.all(adapters.map((adapter) => adapter.listSessions(project)))).flat();
  const seen = new Set<string>();
  const pinned = new Set(pinnedSessionPaths);
  const ordered = sessions
    .filter((session) => {
      if (!session.path || seen.has(session.path)) return false;
      seen.add(session.path);
      return true;
    })
    .map((session) => ({ ...session, title: overrides[session.id] ?? session.title }))
    .sort((left, right) => (right.updatedAt ?? right.createdAt ?? "").localeCompare(left.updatedAt ?? left.createdAt ?? ""));

  return [
    ...ordered.filter((session) => pinned.has(session.path)),
    ...ordered.filter((session) => !pinned.has(session.path)),
  ].slice(0, 50);
}
