import type { DatabaseSync } from "node:sqlite";
export interface SupervisedShellOptions { args: string[]; cwd: string; env: NodeJS.ProcessEnv; onData?: (data: Buffer) => void; signal?: AbortSignal; waitMs?: number }
export interface SupervisedShellResult { exitCode: number; taskId: string; background: boolean }
export type CompletionDisposition = "pending" | "suppress" | "deliver";
export function runSupervisedShell(options: SupervisedShellOptions): Promise<SupervisedShellResult>;
export function completionDispositions(db: DatabaseSync, ids: string[], now?: number): Map<string, CompletionDisposition>;
export function completionDisposition(db: DatabaseSync, id: string, now?: number): CompletionDisposition;
export function readCompletionDispositions(dataDirectory: string, ids: string[]): Map<string, CompletionDisposition>;
export function readCompletionDisposition(dataDirectory: string, id: string): CompletionDisposition;
