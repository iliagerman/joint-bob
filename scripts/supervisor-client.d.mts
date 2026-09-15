export interface SupervisorControl {
  socketPath: string;
  token: string;
  protocolVersion: number;
}

export interface SupervisorRequestOptions {
  token?: string;
  timeoutMs?: number;
}

export function readSupervisorControl(dataDirectory: string): SupervisorControl | null;
export function mintTaskToken(dataDirectory: string, identity: string): string;
export function requestSupervisor<T = unknown>(socketPath: string, token: string, body: object, timeoutMs?: number): Promise<T>;
export function supervisorRequest<T = unknown>(dataDirectory: string, body: object, options?: SupervisorRequestOptions): Promise<T>;
