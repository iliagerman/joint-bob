// Long-polling fallback for networks that block WebSockets (RELAY-PLAN.md D1).
//
// It carries the same binary frames as the WebSocket, as base64 in JSON over plain HTTPS.
// One "receive" request is always outstanding and the relay holds it until it has frames
// to deliver, so delivery is still pushed, not polled on a timer. Outgoing frames go in
// separate "send" requests, one at a time, so both directions stay in order.
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_FRAME } from "./protocol.js";

export const POLL_PATH = "/api/relay/v1/poll";
const HOLD_MS = 25_000;
const IDLE_CLOSE_MS = 60_000;
const CLOSED_GRACE_MS = 30_000;
const MAX_FRAMES_PER_REQUEST = 64;
const MAX_BODY = MAX_FRAMES_PER_REQUEST * Math.ceil(MAX_FRAME * 4 / 3 + 8) + 1024;
const UNTRUSTED_BODY = 64 * 1024;
const OPEN = 1;
const CLOSED = 3;

/** The parts of a ws WebSocket the relay and the machine runtime use. */
export interface FrameSocket extends EventEmitter {
  readonly readyState: number;
  send(frame: Buffer): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

// ------------------------------------------------------------ relay side

class PollSession extends EventEmitter implements FrameSocket {
  readyState = OPEN;
  /** Until the relay accepts the machine, it may send only small bodies (its authentication). */
  trusted = false;
  private readonly queue: Buffer[] = [];

  /** Bytes waiting for the machine to collect, like a WebSocket's bufferedAmount. */
  get bufferedAmount(): number { return this.queue.reduce((total, frame) => total + frame.length, 0); }

  trust(): void { this.trusted = true; }
  private held: ServerResponse | undefined;
  private holdTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private closeReason = "";

  constructor(readonly id: string, private readonly forget: (id: string) => void) {
    super();
    this.touch();
  }

  send(frame: Buffer): void {
    if (this.readyState !== OPEN) return;
    this.queue.push(Buffer.from(frame));
    this.flush();
  }

  close(_code?: number, reason = ""): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.closeReason = reason;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // Frames sent just before closing (a refusal, say) still reach the machine: the session
    // stays until its next receive request collects them, or a grace period passes.
    this.flush();
    const grace = setTimeout(() => this.forget(this.id), CLOSED_GRACE_MS);
    grace.unref();
    this.emit("close");
  }

  terminate(): void { this.close(1006, "Terminated"); }

  /** Frames from the machine, in order. */
  receive(frames: Buffer[]): void {
    if (this.readyState === CLOSED) return;
    this.touch();
    for (const frame of frames) this.emit("message", frame, true);
  }

  /** The machine's outstanding receive request: answered as soon as there is something to say. */
  hold(response: ServerResponse): void {
    if (this.readyState !== CLOSED) this.touch();
    if (this.held) this.answer(this.held, []);
    this.held = response;
    response.on("close", () => { if (this.held === response) { this.held = undefined; if (this.holdTimer) clearTimeout(this.holdTimer); } });
    if (this.queue.length || this.readyState === CLOSED) { this.flush(); return; }
    this.holdTimer = setTimeout(() => this.flush(true), HOLD_MS);
    this.holdTimer.unref();
  }

  private flush(force = false): void {
    if (!this.held || (!force && !this.queue.length && this.readyState !== CLOSED)) return;
    const response = this.held;
    this.held = undefined;
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.answer(response, this.queue.splice(0, MAX_FRAMES_PER_REQUEST));
  }

  private answer(response: ServerResponse, frames: Buffer[]): void {
    const closed = this.readyState === CLOSED && !this.queue.length;
    sendJson(response, 200, { frames: frames.map((frame) => frame.toString("base64")), ...(closed ? { closed: true, reason: this.closeReason } : {}) });
    if (closed) this.forget(this.id);
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(1001, "Idle"), IDLE_CLOSE_MS);
    this.idleTimer.unref();
  }
}

export class PollServer {
  private readonly sessions = new Map<string, PollSession>();

  constructor(private readonly onConnection: (socket: FrameSocket, request: IncomingMessage) => void) {}

  handle(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== "POST") { sendJson(response, 405, { error: "POST only" }); return; }
    // The session is named in the URL, so its body limit is known before the body is read:
    // a new or unauthenticated session can send only a small authentication frame.
    const query = new URL(request.url ?? "/", "http://relay").searchParams;
    if (query.get("new") === "1") {
      void readBody(request, 1024).then(() => {
        const session = new PollSession(randomBytes(24).toString("base64url"), (id) => this.sessions.delete(id));
        this.sessions.set(session.id, session);
        this.onConnection(session, request);
        // The relay's introduction is queued; the first receive request collects it.
        sendJson(response, 200, { session: session.id });
      }, () => sendJson(response, 413, { error: "Body too large" }));
      return;
    }
    const session = this.sessions.get(query.get("session") ?? "");
    if (!session) { void readBody(request, 1024).catch(() => undefined); sendJson(response, 200, { frames: [], closed: true, reason: "Unknown session" }); return; }
    readBody(request, session.trusted ? MAX_BODY : UNTRUSTED_BODY).then((raw) => {
      let frames: Buffer[] | undefined = [];
      if (raw.length) {
        try { frames = decodeFrames((JSON.parse(raw.toString("utf8")) as { frames?: unknown }).frames); } catch { frames = undefined; }
      }
      if (!frames) { sendJson(response, 400, { error: "Invalid frames" }); return; }
      session.receive(frames);
      if (query.get("wait") === "1") session.hold(response);
      else sendJson(response, 200, { frames: [] });
    }, () => { sendJson(response, 413, { error: "Body too large" }); session.close(1009, "Body too large"); });
  }

  closeAll(reason: string): void {
    for (const session of [...this.sessions.values()]) session.close(1001, reason);
  }
}

// ------------------------------------------------------------ machine side

/** A WebSocket look-alike over long-polling, for the machine runtime. */
export class PollClient extends EventEmitter implements FrameSocket {
  readyState = 0;
  private session: string | undefined;
  private readonly outbox: Buffer[] = [];
  private sending = false;
  private readonly controller = new AbortController();

  constructor(private readonly url: string) {
    super();
    void this.start();
  }

  send(frame: Buffer): void {
    if (this.readyState !== OPEN) return;
    this.outbox.push(Buffer.from(frame));
    void this.pumpSend();
  }

  close(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.controller.abort();
    this.emit("close");
  }

  terminate(): void { this.close(); }

  private async request(query: string, body: unknown, timeoutMs: number): Promise<{ session?: string; frames?: string[]; closed?: boolean; reason?: string }> {
    const response = await fetch(`${this.url}?${query}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? "" : JSON.stringify(body), redirect: "error",
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (!response.ok) throw new Error(`Relay poll failed (HTTP ${response.status})`);
    return await response.json() as { session?: string; frames?: string[]; closed?: boolean; reason?: string };
  }

  private async start(): Promise<void> {
    try {
      const opened = await this.request("new=1", undefined, 15_000);
      if (typeof opened.session !== "string") throw new Error("Relay did not open a poll session");
      this.session = opened.session;
      this.readyState = OPEN;
      this.emit("open");
      while (this.readyState === OPEN) {
        const answer = await this.request(`session=${encodeURIComponent(this.session)}&wait=1`, undefined, HOLD_MS + 15_000);
        this.emit("ping");
        for (const frame of decodeFrames(answer.frames) ?? []) this.emit("message", frame, true);
        if (answer.closed) { this.close(); return; }
      }
    } catch (error) {
      if (this.readyState === CLOSED) return;
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
      this.close();
    }
  }

  private async pumpSend(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.outbox.length && this.readyState === OPEN) {
        const frames = this.outbox.splice(0, MAX_FRAMES_PER_REQUEST);
        const answer = await this.request(`session=${encodeURIComponent(this.session ?? "")}`, { frames: frames.map((frame) => frame.toString("base64")) }, 30_000);
        if (answer.closed) { this.close(); return; }
      }
    } catch (error) {
      if (this.readyState !== CLOSED) { this.emit("error", error instanceof Error ? error : new Error(String(error))); this.close(); }
    } finally {
      this.sending = false;
    }
  }
}

export function relayPollUrl(origin: string): string {
  return new URL(POLL_PATH, origin).toString();
}

// ------------------------------------------------------------ helpers

function decodeFrames(value: unknown): Buffer[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_FRAMES_PER_REQUEST) return undefined;
  const frames: Buffer[] = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    const frame = Buffer.from(item, "base64");
    if (!frame.length || frame.length > MAX_FRAME) return undefined;
    frames.push(frame);
  }
  return frames;
}

function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { reject(new Error("Body too large")); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
}
