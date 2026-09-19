export interface SupervisedShellOptions { args: string[]; cwd: string; env: NodeJS.ProcessEnv; onData?: (data: Buffer) => void; signal?: AbortSignal; timeoutMs?: number }
export interface SupervisedShellResult { exitCode: number; taskId: string }
export function runSupervisedShell(options: SupervisedShellOptions): Promise<SupervisedShellResult>;
export function shellTimeoutMs(value: unknown): number | undefined;
