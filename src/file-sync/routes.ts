import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { ClusterV2HttpError } from "../cluster-v2-errors.js";
import { sendError } from "../server/http-auth.js";
import { app } from "../server/state.js";
import { FILE_SYNC_MIN_PROTOCOL, FILE_SYNC_PROTOCOL, type FilesEndpoint, type ServeAnswer } from "./protocol.js";

/* /api/cluster/v2/files/* on the main server: the relay-fallback path into the worker's
   FilesService (FILE-SYNC design §6.3). requireHttpAuth has already verified the signed request
   (core.ts registers it before every route module); the worker authorizes per share. Nothing here
   loads the engine: a node with file sync off answers from this module alone, and old peers that
   never call these routes are unaffected. */

const FILES = "/api/cluster/v2/files";
/** Same ceiling as the direct listener: POST bodies are small JSON. */
const MAX_BODY_BYTES = 1024 * 1024;
const OFF = "File sync is off on this node";
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer"]);

function machineOnly(response: Response): string {
  if (response.locals.machineProtocol !== 2 || typeof response.locals.machineNodeId !== "string") throw new ClusterV2HttpError(401, "Unauthorized");
  return response.locals.machineNodeId as string;
}

/** ZodError → 400, ClusterV2HttpError → its status, a worker that went away → 503; anything else is the app's 500. */
function mapError(error: unknown, response: Response, next: NextFunction): void {
  if (response.headersSent) { response.destroy(error instanceof Error ? error : undefined); return; }
  if (error instanceof z.ZodError) { sendError(response, 400, "Invalid request"); return; }
  if (error instanceof ClusterV2HttpError) { sendError(response, error.statusCode, error.message); return; }
  if ((error as { code?: unknown })?.code === "not-running" || /File sync worker (is not running|stopped)/.test((error as Error)?.message ?? "")) { sendError(response, 503, OFF); return; }
  next(error);
}

/** A whole sharesAnswerSchema answer (wire.ts), so a capable peer can read that the engine is off here. */
async function offSharesAnswer(): Promise<unknown> {
  // Both are loaded by the running server already; neither starts anything.
  const [{ getClusterNode }, { fileSyncHostId }] = await Promise.all([import("../cluster.js"), import("./shares.js")]);
  return {
    fileSync: { protocol: FILE_SYNC_PROTOCOL, minProtocol: FILE_SYNC_MIN_PROTOCOL, enabled: false },
    nodeId: (await getClusterNode()).id, hostId: fileSyncHostId(), origins: [], shares: [], engines: [], settings: [],
  };
}

function query(request: Request): Record<string, string> {
  // From the signed target itself, not Express's qs parse (which turns `a[b]=1` into objects).
  const values: Record<string, string> = {};
  const search = new URLSearchParams(request.originalUrl.split("?")[1] ?? "");
  for (const [key, value] of search) if (!(key in values)) values[key] = value;
  return values;
}

async function writeAnswer(response: Response, answer: ServeAnswer): Promise<void> {
  const headers: Record<string, string> = {};
  const whole = answer.json !== undefined || !answer.body;
  for (const [name, value] of Object.entries(answer.headers ?? {})) {
    const lower = name.toLowerCase();
    // Express sizes a JSON answer itself.
    if (!HOP_BY_HOP.has(lower) && !(whole && lower === "content-length")) headers[lower] = String(value);
  }
  response.status(answer.status);
  response.set(headers);
  if (whole) {
    if (answer.body) void answer.body[Symbol.asyncIterator]().return?.();
    if (answer.json === undefined) response.end(); else response.json(answer.json);
    return;
  }
  const { pipeBody } = await import("./direct.js");
  await pipeBody(response, answer.body!);
}

function route(endpoint: FilesEndpoint, method: "GET" | "POST") {
  return (request: Request, response: Response, next: NextFunction): void => {
    void (async () => {
      const peer = machineOnly(response);
      // Express routes HEAD to GET handlers; a HEAD answer would stream a whole body into nothing.
      if (request.method !== method) throw new ClusterV2HttpError(404, "Not found");
      if (method === "POST" && Number(request.header("content-length") ?? 0) > MAX_BODY_BYTES) throw new ClusterV2HttpError(413, "File sync request body is too large");
      const { servingBridge } = await import("./bridge.js");
      const bridge = servingBridge();
      if (!bridge) {
        // A peer probing for the engine learns it is off here; an old node answers 404 instead.
        if (endpoint === "shares") { response.json(await offSharesAnswer()); return; }
        throw new ClusterV2HttpError(503, OFF);
      }
      const controller = new AbortController();
      response.once("close", () => { if (!response.writableFinished) controller.abort(new DOMException("The peer closed the request", "AbortError")); });
      const range = endpoint === "file" ? request.header("range") : undefined;
      const answer = await bridge.serve({ peer, endpoint, query: query(request), ...(method === "POST" ? { body: request.body ?? {} } : {}), ...(range ? { range } : {}) }, { signal: controller.signal });
      if (controller.signal.aborted) { if (answer.body) void answer.body[Symbol.asyncIterator]().return?.(); return; }
      await writeAnswer(response, answer);
    })().catch((error) => mapError(error, response, next));
  };
}

const ENDPOINTS: ReadonlyArray<[FilesEndpoint, "GET" | "POST"]> = [["shares", "GET"], ["index", "GET"], ["changed", "POST"], ["fetch", "POST"], ["file", "POST"], ["status", "POST"]];

for (const [endpoint, method] of ENDPOINTS) {
  if (method === "GET") app.get(`${FILES}/${endpoint}`, route(endpoint, method));
  else app.post(`${FILES}/${endpoint}`, route(endpoint, method));
}
