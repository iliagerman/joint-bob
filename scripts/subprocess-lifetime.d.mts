import type { ChildProcess } from "node:child_process";
export const DEFAULT_SUBPROCESS_MAX_LIFETIME_MINUTES: 360;
export const MAX_SUBPROCESS_MAX_LIFETIME_MINUTES: 10080;
export function validSubprocessLifetime(value: unknown): boolean;
export function subprocessLifetimeMs(dataDirectory: string): number;
export interface ProcessIdentity { pid: number; parent: number; uid: number; birth: string }
export interface LifetimeWatch { dispose(): void; readonly active: boolean; readonly descendantCount: number; exited(): void }
export function watchSubprocess(child: Pick<ChildProcess, "pid" | "kill"> & Partial<Pick<ChildProcess, "exitCode" | "signalCode" | "once" | "removeListener">>, options?: {
  dataDirectory?: string;
  lifetimeMs?: () => number;
  graceMs?: number;
  pollMs?: number;
  onExpire?: () => void;
  observe?: () => Promise<Map<number, ProcessIdentity>>;
  observeFresh?: () => Promise<Map<number, ProcessIdentity>>;
  signalDescendant?: (pid: number, signal: NodeJS.Signals) => void;
}): LifetimeWatch;
