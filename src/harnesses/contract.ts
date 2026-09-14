import type { ChatMessage, HarnessId, ProjectRecord, SessionSummary } from "../types.js";
import type { HarnessConfiguration } from "./runtime-configuration.js";
import type { HarnessFork } from "./fork.js";
import type { HarnessRuntime } from "./runtime.js";
import type { HarnessResources } from "./resource-contract.js";
import type { SessionProjectPaths } from "./shared-paths.js";

export interface HarnessProject extends ProjectRecord {
  additionalPaths?: string[];
  /** Zero loads all summaries. Positive values skip older transcripts until opened directly. */
  historyDays?: number;
  includedSessionPaths?: string[];
  includedSessionIds?: string[];
}

export interface HarnessAdapter<TId extends HarnessId = HarnessId> {
  id: TId;
  label: string;
  order?: number;
  defaults: import("./defaults.js").ConversationDefault;
  configuration?: HarnessConfiguration;
  runtime?: () => Promise<HarnessRuntime>;
  fork?: () => Promise<HarnessFork>;
  resources?: () => Promise<HarnessResources>;
  paths: {
    newSession: string;
    ownsSession: (sessionPath: string) => boolean;
    ownsTranscript: (filePath: string) => boolean;
    sessionId: (sessionPath: string) => string | undefined;
    localize?: (sessionPath: string, homePath: string) => string;
    transcriptFile?: (sessionPath: string) => string;
    canonicalTranscript?: (filePath: string) => string;
  };
  sync: {
    transcriptRoot: () => string;
    watchDirs?: (project: SessionProjectPaths) => string[];
    /** Returns the owning cwd when a shared transcript directory carries a reliable header. */
    transcriptCwd?: (filePath: string) => Promise<string | null>;
  };
  sessions: {
    files: (project: HarnessProject) => Promise<string[]>;
    list: (project: HarnessProject) => Promise<SessionSummary[]>;
    refresh: (project: HarnessProject, previous: SessionSummary[], changedFiles: string[]) => Promise<SessionSummary[]>;
    loadMessages: (project: ProjectRecord, sessionPath: string) => Promise<ChatMessage[]>;
    recover?: (sessionPath: string, cwd: string) => Promise<void>;
  };
}

export function defineHarness<TId extends HarnessId>(adapter: HarnessAdapter<TId>): HarnessAdapter<TId> {
  return adapter;
}
