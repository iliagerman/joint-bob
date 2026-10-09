import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { MAX_FRAME } from "./protocol.js";
const POLL_PATH = "/api/relay/v1/poll";
const HOLD_MS = 25e3;
const IDLE_CLOSE_MS = 6e4;
const CLOSED_GRACE_MS = 3e4;
const MAX_FRAMES_PER_REQUEST = 64;
const MAX_BODY = MAX_FRAMES_PER_REQUEST * Math.ceil(MAX_FRAME * 4 / 3 + 8) + 1024;
const UNTRUSTED_BODY = 64 * 1024;
const OPEN = 1;
const CLOSED = 3;
class PollSession extends EventEmitter {
  constructor(id, forget) {
    super();
    this.id = id;
    this.forget = forget;
    this.touch();
  }
  id;
  forget;
  readyState = OPEN;
  /** Until the relay accepts the machine, it may send only small bodies (its authentication). */
  trusted = false;
  queue = [];
  /** Bytes waiting for the machine to collect, like a WebSocket's bufferedAmount. */
  get bufferedAmount() {
    return this.queue.reduce((total, frame) => total + frame.length, 0);
  }
  trust() {
    this.trusted = true;
  }
  held;
  holdTimer;
  idleTimer;
  closeReason = "";
  send(frame) {
    if (this.readyState !== OPEN) return;
    this.queue.push(Buffer.from(frame));
    this.flush();
  }
  close(_code, reason = "") {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.closeReason = reason;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.flush();
    const grace = setTimeout(() => this.forget(this.id), CLOSED_GRACE_MS);
    grace.unref();
    this.emit("close");
  }
  terminate() {
    this.close(1006, "Terminated");
  }
  /** Frames from the machine, in order. */
  receive(frames) {
    if (this.readyState === CLOSED) return;
    this.touch();
    for (const frame of frames) this.emit("message", frame, true);
  }
  /** The machine's outstanding receive request: answered as soon as there is something to say. */
  hold(response) {
    if (this.readyState !== CLOSED) this.touch();
    if (this.held) this.answer(this.held, []);
    this.held = response;
    response.on("close", () => {
      if (this.held === response) {
        this.held = void 0;
        if (this.holdTimer) clearTimeout(this.holdTimer);
      }
    });
    if (this.queue.length || this.readyState === CLOSED) {
      this.flush();
      return;
    }
    this.holdTimer = setTimeout(() => this.flush(true), HOLD_MS);
    this.holdTimer.unref();
  }
  flush(force = false) {
    if (!this.held || !force && !this.queue.length && this.readyState !== CLOSED) return;
    const response = this.held;
    this.held = void 0;
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.answer(response, this.queue.splice(0, MAX_FRAMES_PER_REQUEST));
  }
  answer(response, frames) {
    const closed = this.readyState === CLOSED && !this.queue.length;
    sendJson(response, 200, { frames: frames.map((frame) => frame.toString("base64")), ...closed ? { closed: true, reason: this.closeReason } : {} });
    if (closed) this.forget(this.id);
  }
  touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(1001, "Idle"), IDLE_CLOSE_MS);
    this.idleTimer.unref();
  }
}
class PollServer {
  constructor(onConnection) {
    this.onConnection = onConnection;
  }
  onConnection;
  sessions = /* @__PURE__ */ new Map();
  handle(request, response) {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "POST only" });
      return;
    }
    const query = new URL(request.url ?? "/", "http://relay").searchParams;
    if (query.get("new") === "1") {
      void readBody(request, 1024).then(() => {
        const session2 = new PollSession(randomBytes(24).toString("base64url"), (id) => this.sessions.delete(id));
        this.sessions.set(session2.id, session2);
        this.onConnection(session2, request);
        sendJson(response, 200, { session: session2.id });
      }, () => sendJson(response, 413, { error: "Body too large" }));
      return;
    }
    const session = this.sessions.get(query.get("session") ?? "");
    if (!session) {
      void readBody(request, 1024).catch(() => void 0);
      sendJson(response, 200, { frames: [], closed: true, reason: "Unknown session" });
      return;
    }
    readBody(request, session.trusted ? MAX_BODY : UNTRUSTED_BODY).then((raw) => {
      let frames = [];
      if (raw.length) {
        try {
          frames = decodeFrames(JSON.parse(raw.toString("utf8")).frames);
        } catch {
          frames = void 0;
        }
      }
      if (!frames) {
        sendJson(response, 400, { error: "Invalid frames" });
        return;
      }
      session.receive(frames);
      if (query.get("wait") === "1") session.hold(response);
      else sendJson(response, 200, { frames: [] });
    }, () => {
      sendJson(response, 413, { error: "Body too large" });
      session.close(1009, "Body too large");
    });
  }
  closeAll(reason) {
    for (const session of [...this.sessions.values()]) session.close(1001, reason);
  }
}
class PollClient extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    void this.start();
  }
  url;
  readyState = 0;
  session;
  outbox = [];
  sending = false;
  controller = new AbortController();
  send(frame) {
    if (this.readyState !== OPEN) return;
    this.outbox.push(Buffer.from(frame));
    void this.pumpSend();
  }
  close() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.controller.abort();
    this.emit("close");
  }
  terminate() {
    this.close();
  }
  async request(query, body, timeoutMs) {
    const response = await fetch(`${this.url}?${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === void 0 ? "" : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(timeoutMs)])
    });
    if (!response.ok) throw new Error(`Relay poll failed (HTTP ${response.status})`);
    return await response.json();
  }
  async start() {
    try {
      const opened = await this.request("new=1", void 0, 15e3);
      if (typeof opened.session !== "string") throw new Error("Relay did not open a poll session");
      this.session = opened.session;
      this.readyState = OPEN;
      this.emit("open");
      while (this.readyState === OPEN) {
        const answer = await this.request(`session=${encodeURIComponent(this.session)}&wait=1`, void 0, HOLD_MS + 15e3);
        this.emit("ping");
        for (const frame of decodeFrames(answer.frames) ?? []) this.emit("message", frame, true);
        if (answer.closed) {
          this.close();
          return;
        }
      }
    } catch (error) {
      if (this.readyState === CLOSED) return;
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
      this.close();
    }
  }
  async pumpSend() {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.outbox.length && this.readyState === OPEN) {
        const frames = this.outbox.splice(0, MAX_FRAMES_PER_REQUEST);
        const answer = await this.request(`session=${encodeURIComponent(this.session ?? "")}`, { frames: frames.map((frame) => frame.toString("base64")) }, 3e4);
        if (answer.closed) {
          this.close();
          return;
        }
      }
    } catch (error) {
      if (this.readyState !== CLOSED) {
        this.emit("error", error instanceof Error ? error : new Error(String(error)));
        this.close();
      }
    } finally {
      this.sending = false;
    }
  }
}
function relayPollUrl(origin) {
  return new URL(POLL_PATH, origin).toString();
}
function decodeFrames(value) {
  if (value === void 0) return [];
  if (!Array.isArray(value) || value.length > MAX_FRAMES_PER_REQUEST) return void 0;
  const frames = [];
  for (const item of value) {
    if (typeof item !== "string") return void 0;
    const frame = Buffer.from(item, "base64");
    if (!frame.length || frame.length > MAX_FRAME) return void 0;
    frames.push(frame);
  }
  return frames;
}
function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}
function sendJson(response, status, body) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
}
export {
  POLL_PATH,
  PollClient,
  PollServer,
  relayPollUrl
};
