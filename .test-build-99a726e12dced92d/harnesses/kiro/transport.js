import { StringDecoder } from "node:string_decoder";
function asRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid JSON-RPC envelope: expected an object");
  }
  const record = value;
  if (record.jsonrpc !== "2.0") throw new Error("Invalid JSON-RPC envelope: jsonrpc must be 2.0");
  return record;
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
class KiroConnection {
  constructor(child, onNotification, onRequest) {
    this.child = child;
    this.onNotification = onNotification;
    this.onRequest = onRequest;
    let resolveClosed;
    this.closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    this.resolveClosed = resolveClosed;
    child.stdout.on("data", (chunk) => this.receive(chunk));
    child.stderr.on("data", (chunk) => this.captureStderr(chunk));
    child.stdin.on("error", (error) => this.fail(error));
    child.on("error", (error) => {
      this.fail(error);
      this.resolveClosed();
    });
    child.on("close", (code, signal) => {
      this.fail(this.exitError(code, signal));
      this.resolveClosed();
    });
  }
  child;
  onNotification;
  onRequest;
  buffer = "";
  stderr = "";
  stdoutDecoder = new StringDecoder("utf8");
  stderrDecoder = new StringDecoder("utf8");
  nextId = 1;
  failure;
  pending = /* @__PURE__ */ new Map();
  resolveClosed;
  closed;
  request(method, params) {
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
  notify(method, params) {
    if (this.failure) throw this.failure;
    try {
      this.write({ jsonrpc: "2.0", method, params });
    } catch (error) {
      this.fail(error);
      throw this.failure;
    }
  }
  receive(chunk) {
    if (this.failure) return;
    this.buffer += this.stdoutDecoder.write(chunk);
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.dispatch(asRecord(JSON.parse(line)));
      } catch (error) {
        this.fail(error);
        return;
      }
    }
  }
  dispatch(record) {
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
  handleReply(record) {
    const hasResult = Object.hasOwn(record, "result");
    const hasError = Object.hasOwn(record, "error");
    if (typeof record.id !== "number" || hasResult === hasError) {
      throw new Error("Invalid JSON-RPC reply envelope");
    }
    const pending = this.pending.get(record.id);
    if (!pending) throw new Error(`Uncorrelatable JSON-RPC reply id: ${record.id}`);
    const detail = hasError ? asRpcError(record.error) : void 0;
    this.pending.delete(record.id);
    if (detail) pending.reject(new Error(detail.message));
    else pending.resolve(record.result);
  }
  handleServerRequest(record) {
    if (typeof record.id !== "number" && typeof record.id !== "string" || record.id === "") {
      throw new Error("Invalid JSON-RPC request id");
    }
    const id = record.id;
    void this.onRequest(record.method, record.params).then(
      (result) => this.writeResponse({ jsonrpc: "2.0", id, result }),
      (error) => this.writeResponse({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: errorMessage(error) }
      })
    );
  }
  writeResponse(record) {
    if (this.failure) return;
    try {
      this.write(record);
    } catch (error) {
      this.fail(error);
    }
  }
  write(record) {
    this.child.stdin.write(`${JSON.stringify(record)}
`);
  }
  captureStderr(chunk) {
    this.stderr = (this.stderr + this.stderrDecoder.write(chunk)).slice(-2e3);
  }
  exitError(code, signal) {
    const status = code === null ? `signal ${signal}` : `code ${code}`;
    const suffix = this.stderr ? `
${this.stderr}` : "";
    return new Error(`Kiro ACP process exited with ${status}${suffix}`);
  }
  fail(reason) {
    if (this.failure) return;
    this.failure = reason instanceof Error ? reason : new Error(String(reason));
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
    if (this.child.exitCode === null && this.child.signalCode === null && !this.child.killed) this.child.kill();
  }
}
function asRpcError(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid JSON-RPC error reply");
  }
  const error = value;
  if (typeof error.code !== "number" || typeof error.message !== "string") {
    throw new Error("Invalid JSON-RPC error reply");
  }
  const detail = typeof error.data === "string" ? error.data.trim() : "";
  return { message: detail && detail !== error.message ? `${error.message}: ${detail}` : error.message };
}
function createKiroConnection(child, onNotification, onRequest) {
  const connection = new KiroConnection(child, onNotification, onRequest);
  return {
    request: (method, params) => connection.request(method, params),
    notify: (method, params) => connection.notify(method, params),
    closed: connection.closed
  };
}
export {
  createKiroConnection
};
