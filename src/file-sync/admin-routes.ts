import type { Response } from "express";
import { z } from "zod";
import { sendError } from "../server/http-auth.js";
import { app } from "../server/state.js";
import { fileSyncConfigPatchSchema } from "./control.js";
import { nodeIdSchema } from "./wire.js";

/* Settings → File sync, for the node's admin only (ADMIN_ROUTES in server/admin.ts). The engine
   loads on first use, so registering these routes adds nothing to the server's startup. Lists page
   like the relay's (page from 1, pageSize up to 50) and answer {total, items}. */

const share = z.string().min(1).max(300);
const page = z.object({ page: z.coerce.number().int().positive().max(100_000).default(1), pageSize: z.coerce.number().int().positive().max(50).default(10) });
const differencesQuery = page.extend({ share, peer: nodeIdSchema });
const errorsQuery = page.extend({ share });
const shareBody = z.object({ share }).strict();
const repairBody = z.object({ share, peer: nodeIdSchema }).strict();

/** The engine's refusals carry their HTTP status; a malformed request is a 400; anything else goes to the error handler. */
async function answer(response: Response, next: (error: unknown) => void, work: () => Promise<unknown>): Promise<void> {
  try {
    response.json(await work());
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, error.errors.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join(", ")); return; }
    const { FileSyncRequestError } = await import("./index.js");
    if (error instanceof FileSyncRequestError) { sendError(response, error.status, error.message); return; }
    next(error);
  }
}

app.get("/api/file-sync/status", (_request, response, next) => answer(response, next, async () => {
  const { fileSyncStatus } = await import("./index.js");
  return fileSyncStatus();
}));

app.put("/api/file-sync/config", (request, response, next) => answer(response, next, async () => {
  const patch = fileSyncConfigPatchSchema.parse(request.body ?? {});
  const { applyFileSyncConfig } = await import("./index.js");
  return applyFileSyncConfig(patch);
}));

app.get("/api/file-sync/differences", (request, response, next) => answer(response, next, async () => {
  const query = differencesQuery.parse(request.query);
  const { fileSyncDifferences } = await import("./index.js");
  return fileSyncDifferences(query.share, query.peer, (query.page - 1) * query.pageSize, query.pageSize);
}));

app.get("/api/file-sync/errors", (request, response, next) => answer(response, next, async () => {
  const query = errorsQuery.parse(request.query);
  const { fileSyncErrors } = await import("./index.js");
  return fileSyncErrors(query.share, (query.page - 1) * query.pageSize, query.pageSize);
}));

app.post("/api/file-sync/repair", (request, response, next) => answer(response, next, async () => {
  const body = repairBody.parse(request.body ?? {});
  const { fileSyncRepair } = await import("./index.js");
  await fileSyncRepair(body.share, body.peer);
  return { ok: true };
}));

app.post("/api/file-sync/held/release", (request, response, next) => answer(response, next, async () => {
  const body = shareBody.parse(request.body ?? {});
  const { fileSyncReleaseHeld } = await import("./index.js");
  return fileSyncReleaseHeld(body.share);
}));

app.post("/api/file-sync/replaced/confirm", (request, response, next) => answer(response, next, async () => {
  const body = shareBody.parse(request.body ?? {});
  const { fileSyncConfirmReplaced } = await import("./index.js");
  return fileSyncConfirmReplaced(body.share);
}));
