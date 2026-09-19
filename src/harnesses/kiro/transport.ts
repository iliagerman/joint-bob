import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type RpcRecord = Record<string, unknown>;
type NotificationHandler = (method: string, params: unknown) => void;
type RequestHandler = (method: string, params: unknown) => Promise<unknown>;

function asRecord(value: unknown): RpcRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid JSON-RPC envelope: expected an object");
  }
  const record = value as RpcRecord;
  if (record.jsonrpc !== "2.0") throw new Error("Invalid JSON-RPC envelope: jsonrpc must be 2.0");
  return record;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class KiroConnection {
  private buffer = "";
  private stderr = "";
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");
  private nextId = 1;
  private failure: Error | undefined;
  private readonly pending = new Map<number, Pending>();
  private readonly resolveClosed: () => void;
  readonly closed: Promise<void>;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onNotification: NotificationHandler,
    private readonly onRequest: RequestHandler,
  ) {
    let resolveClosed!: () => void;
    this.closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    this.resolveClosed = resolveClosed;
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.captureStderr(chunk));
    child.stdin.on("error", (error) => this.fail(error));
    child.on("error", (error) => { this.fail(error); this.resolveClosed(); });
    child.on("close", (code, signal) => { this.fail(this.exitError(code, signal)); this.resolveClosed(); });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.fail(error);
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (this.failure) throw this.failure;
    try {
      this.write({ jsonrpc: "2.0", method, params });
    } catch (error) {
      this.fail(error);
      throw this.failure;
    }
  }

  private receive(chunk: Buffer): void {
    if (this.failure) return;
    this.buffer += this.stdoutDecoder.write(chunk);
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.dispatch(asRecord(JSON.parse(line) as unknown));
      } catch (error) {
        this.fail(error);
        return;
      }
    }
  }

  private dispatch(record: RpcRecord): void {
    if (Object.hasOwn(record, "method")) {
      if (typeof record.method !== "string" || Object.hasOwn(record, "result") || Object.hasOwn(record, "error")) {
        throw new Error("Invalid JSON-RPC method envelope");
      }
      if (Object.hasOwn(record, "id")) this.handleServerRequest(record);
      else this.onNotification(record.method, record.params);
      return;
    }
    this.handleReply(record);
  }

  private handleReply(record: RpcRecord): void {
    const hasResult = Object.hasOwn(record, "result");
    const hasError = Object.hasOwn(record, "error");
    if (typeof record.id !== "number" || hasResult === hasError) {
      throw new Error("Invalid JSON-RPC reply envelope");
    }
    const pending = this.pending.get(record.id);
    if (!pending) throw new Error(`Uncorrelatable JSON-RPC reply id: ${record.id}`);
    const detail = hasError ? asRpcError(record.error) : undefined;
    this.pending.delete(record.id);
    if (detail) pending.reject(new Error(detail.message));
    else pending.resolve(record.result);
  }

  private handleServerRequest(record: RpcRecord): void {
    if ((typeof record.id !== "number" && typeof record.id !== "string") || record.id === "") {
      throw new Error("Invalid JSON-RPC request id");
    }
    const id = record.id;
    void this.onRequest(record.method as string, record.params).then(
      (result) => this.writeResponse({ jsonrpc: "2.0", id, result }),
      (error) => this.writeResponse({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: errorMessage(error) },
      }),
    );
  }

  private writeResponse(record: RpcRecord): void {
    if (this.failure) return;
    try {
      this.write(record);
    } catch (error) {
      this.fail(error);
    }
  }

  private write(record: RpcRecord): void {
    this.child.stdin.write(`${JSON.stringify(record)}\n`);
  }

  private captureStderr(chunk: Buffer): void {
    this.stderr = (this.stderr + this.stderrDecoder.write(chunk)).slice(-2000);
  }

  private exitError(code: number | null, signal: NodeJS.Signals | null): Error {
    const status = code === null ? `signal ${signal}` : `code ${code}`;
    const suffix = this.stderr ? `\n${this.stderr}` : "";
    return new Error(`Kiro ACP process exited with ${status}${suffix}`);
  }

  private fail(reason: unknown): void {
    if (this.failure) return;
    this.failure = reason instanceof Error ? reason : new Error(String(reason));
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
    if (this.child.exitCode === null && this.child.signalCode === null && !this.child.killed) this.child.kill();
  }
}

function asRpcError(value: unknown): { message: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid JSON-RPC error reply");
  }
  const error = value as Record<string, unknown>;
  if (typeof error.code !== "number" || typeof error.message !== "string") {
    throw new Error("Invalid JSON-RPC error reply");
  }
  // Kiro answers a failed turn with the generic "Internal error" and puts the
  // reason (quota, auth, stream failure) in data, so the reason must travel too.
  const detail = typeof error.data === "string" ? error.data.trim() : "";
  return { message: detail && detail !== error.message ? `${error.message}: ${detail}` : error.message };
}

export function createKiroConnection(
  child: ChildProcessWithoutNullStreams,
  onNotification: NotificationHandler,
  onRequest: RequestHandler,
): {
  request: (method: string, params: unknown) => Promise<unknown>;
  notify: (method: string, params: unknown) => void;
  closed: Promise<void>;
} {
  const connection = new KiroConnection(child, onNotification, onRequest);
  return {
    request: (method, params) => connection.request(method, params),
    notify: (method, params) => connection.notify(method, params),
    closed: connection.closed,
  };
}
