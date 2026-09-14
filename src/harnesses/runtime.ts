import type { ChatMessage, ModelSummary, SessionStatus } from "../types.js";

export type HarnessEvent = Record<string, unknown>;
export interface HarnessModelSettings { provider: string; modelId: string; reasoning: string; enabledTools?: string[] }
export interface HarnessPrompt {
  text: string;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  /** Final caller execution fence, run after native preparation and immediately before model execution. */
  beforeStart?: () => Promise<void>;
  onStarted?: () => void;
}
export interface HarnessOpenOptions { projectId: string; cwd: string; sessionId: string; sessionPath?: string; conversationId?: string; accountIds?: string[] }
export interface HarnessTool { name: string; description: string; active: boolean }
export interface HarnessSession {
  readonly id: string; readonly file: string | undefined; readonly messages: ChatMessage[];
  status(): SessionStatus; isBusy(): boolean; queuedPrompts(): string[]; settings(): HarnessModelSettings;
  subscribe(listener: (event: HarnessEvent) => void): () => void;
  preflight(): Promise<void>; prompt(input: HarnessPrompt): Promise<void>;
  configure(settings: HarnessModelSettings): Promise<void>;
  tools(): HarnessTool[]; setTools(names: string[]): Promise<void>;
  compact(instructions?: string, beforeStart?: () => Promise<void>): Promise<void>; rename(name: string): Promise<void>;
  reload(): Promise<void>; setSafeguards(enabled: boolean): Promise<void>;
  cancel(): Promise<void>; stopForUpdate(): Promise<void>; dispose(): void;
}
export interface HarnessRuntime {
  open(options: HarnessOpenOptions): Promise<HarnessSession>;
  models(): Promise<Array<ModelSummary & { thinkingLevels: string[] }>>;
  validateSettings(settings: HarnessModelSettings): Promise<void>;
  readiness(cwd: string, env?: NodeJS.ProcessEnv): Promise<string[]>;
  externalRunning?: () => Promise<Array<{ sessionId: string; runId: string }>>;
}
