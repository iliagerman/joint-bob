import type { LifetimeWatch, ProcessIdentity } from "./subprocess-lifetime.mjs";
export const MIN_CONVERSATION_CPU_CORES: 0.1;
export const MAX_CONVERSATION_CPU_CORES: 1024;
export const MIN_CONVERSATION_MEMORY_GB: 0.1;
export const MAX_CONVERSATION_MEMORY_GB: 4096;
export function validConversationCpuLimit(value: unknown): boolean;
export function validConversationMemoryLimit(value: unknown): boolean;
export interface ConversationLimits { cpuCores: number | null; memoryGb: number | null }
export function conversationLimits(dataDirectory: string): ConversationLimits;
export interface ConversationLimiter {
  add(task: { identity: string; id: string; watch: Pick<LifetimeWatch, "descendants">; isStopping?: () => boolean; onMemoryExceeded: (reason: string) => void }): { dispose(): void };
  poll(): Promise<void>;
  readonly fractions: Map<string, number>;
  close(): void;
}
export function createConversationLimiter(options?: {
  dataDirectory?: string;
  limits?: () => ConversationLimits;
  observe?: () => Promise<Map<number, ProcessIdentity> & { capturedAt?: number }>;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  now?: () => number;
  pollMs?: number;
  sliceMs?: number;
  memoryStrikes?: number;
}): ConversationLimiter;
