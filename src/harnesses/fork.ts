import type { ProjectRecord } from "../types.js";
import type { HarnessSession } from "./runtime.js";

export class HarnessForkError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface HarnessForkFile { destination: string; contents: string | Buffer }
export interface HarnessForkOptions {
  project: ProjectRecord;
  sessionId: string;
  sessionPath: string;
  newSessionId: string;
  title: string;
  timestamp: string;
  draft: boolean;
  live?: HarnessSession;
}
export interface HarnessForkSnapshot { sessionPath: string; files: HarnessForkFile[] }
export type HarnessFork = (options: HarnessForkOptions) => HarnessForkSnapshot;
