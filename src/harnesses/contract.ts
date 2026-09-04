import type { ChatMessage, HarnessId, ProjectRecord, SessionSummary } from "../types.js";

export interface HarnessProject extends ProjectRecord {
  additionalPaths?: string[];
}

export interface HarnessAdapter<TId extends HarnessId = HarnessId> {
  id: TId;
  label: string;
  order?: number;
  paths: {
    newSession: string;
    ownsSession: (sessionPath: string) => boolean;
    ownsTranscript: (filePath: string) => boolean;
    sessionId: (sessionPath: string) => string | undefined;
  };
  sync: {
    transcriptRoot: () => string;
  };
  sessions: {
    files: (project: HarnessProject) => Promise<string[]>;
    list: (project: HarnessProject) => Promise<SessionSummary[]>;
    refresh: (project: HarnessProject, previous: SessionSummary[], changedFiles: string[]) => Promise<SessionSummary[]>;
    loadMessages: (project: ProjectRecord, sessionPath: string) => Promise<ChatMessage[]>;
  };
}

export function defineHarness<TId extends HarnessId>(adapter: HarnessAdapter<TId>): HarnessAdapter<TId> {
  return adapter;
}
