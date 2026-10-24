import type { ClientRequest } from "node:http";
import type { RelayStream } from "./stream.js";

// Error messages and arbitrary codes can contain URLs or caller-supplied abort reasons.
const ERROR_CODES = new Set(["ERELAYCHANNEL", "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ABORT_ERR", "ERR_STREAM_DESTROYED", "ERR_STREAM_PREMATURE_CLOSE"]);

/** Observe transport failures only. Never receives a URL, headers, body or application data. */
export function observeRelayRequest(request: ClientRequest, peerId: string, signal?: AbortSignal): void {
  const started = performance.now();
  let assigned: number | undefined, ready: number | undefined, sent: number | undefined, answered: number | undefined;
  let stream: RelayStream | undefined;
  let reported = false, uploadFinished = false;
  // HTTP can finish buffering a request before this socket-like stream is ready.
  const markReady = (): void => { ready = performance.now(); if (uploadFinished) sent = ready; };
  const cleanup = (): void => {
    stream?.off("relay-ready", markReady);
    signal?.removeEventListener("abort", aborted);
  };
  const report = (code: string): void => {
    if (reported) return;
    reported = true;
    const now = performance.now();
    console.warn(JSON.stringify({
      event: "relay_peer_request_failed", at: new Date().toISOString(), peerId, code,
      phase: answered !== undefined ? "body" : assigned === undefined ? "queue" : ready === undefined ? "channel" : sent === undefined ? "send" : "response",
      transport: stream?.relayRoute?.transport ?? null, membershipId: stream?.relayRoute?.membershipId ?? null,
      reusedSocket: request.reusedSocket, durationMs: Math.round(now - started),
      queueMs: Math.round((assigned ?? now) - started),
      channelMs: assigned === undefined ? null : Math.round((ready ?? now) - assigned),
      sendMs: ready === undefined ? null : Math.round((sent ?? now) - ready),
      responseMs: sent === undefined ? null : Math.round(Math.max(0, (answered ?? now) - sent)),
      bodyMs: answered === undefined ? null : Math.round(now - answered),
    }));
    cleanup();
  };
  const aborted = (): void => report(signal?.reason instanceof Error && signal.reason.name === "TimeoutError" ? "TIMEOUT" : "ABORTED");
  const failed = (error: NodeJS.ErrnoException): void => {
    if (signal?.aborted) aborted();
    else report(error.code && ERROR_CODES.has(error.code) ? error.code : "UNKNOWN");
  };
  request.once("socket", (socket) => {
    assigned = performance.now();
    stream = socket as unknown as RelayStream;
    if (stream.connecting) stream.once("relay-ready", markReady);
    else { ready = assigned; if (uploadFinished) sent = ready; }
  });
  request.once("finish", () => { uploadFinished = true; if (ready !== undefined) sent = performance.now(); });
  request.once("response", (response) => {
    answered = performance.now();
    response.once("error", failed);
    response.once("end", cleanup);
    response.once("close", cleanup);
  });
  request.once("error", failed);
  request.once("close", () => { if (answered === undefined) cleanup(); });
  // A queued request may not emit its error until a socket becomes free. Record the
  // abort immediately so its phase and duration describe the failure, not later cleanup.
  signal?.addEventListener("abort", aborted, { once: true });
}
