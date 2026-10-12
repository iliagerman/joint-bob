import type { ChatMessage, HarnessId, ProjectRecord, SessionSummary } from "../types.js";
import type { HarnessConfiguration } from "./runtime-configuration.js";
import type { HarnessFork } from "./fork.js";
import type { HarnessModel, HarnessRuntime } from "./runtime.js";
import type { HarnessResources } from "./resource-contract.js";
import type { SessionProjectPaths } from "./shared-paths.js";

export interface HarnessProject extends ProjectRecord {
  additionalPaths?: string[];
  /** Zero loads all summaries. Positive values skip older transcripts until opened directly. */
  historyDays?: number;
  includedSessionPaths?: string[];
  includedSessionIds?: string[];
  recordSessionIds?: string[];
  /** Summarize a transcript that holds only the automatic start command. Lists hide those; opening one must not. */
  includeUnstarted?: boolean;
}

export interface HarnessAdapter<TId extends HarnessId = HarnessId> {
  id: TId;
  label: string;
  order?: number;
  defaults: import("./defaults.js").ConversationDefault;
  configuration?: HarnessConfiguration;
  runtime?: () => Promise<HarnessRuntime>;
  /** The models this node can run through the harness; required whenever `runtime` is set. */
  models?: () => Promise<HarnessModel[]>;
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
    /** Whether a transcript entry holds something a person sent. A conversation continued on
        two machines settles itself only for a harness that can tell. */
    sentByPerson?: (entry: Record<string, unknown>) => boolean;
    /** Whether a transcript can be one of a project's, judged from its path alone. A harness
        that keeps each working directory's transcripts in its own folder answers here, so a
        write is announced to the projects it concerns rather than to every project watching
        the shared root. */
    transcriptBelongs?: (project: SessionProjectPaths, filePath: string) => boolean;
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
