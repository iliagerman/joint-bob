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

app.post("/api/file-sync/replaced/confirm", (request, response, next) => answer(response, next, async () => {
  const body = shareBody.parse(request.body ?? {});
  const { fileSyncConfirmReplaced } = await import("./index.js");
  return fileSyncConfirmReplaced(body.share);
}));

/* The per-project switch (cutover-engine, P5): the listing, the checks before a move, and the move.
   A refused move answers 409 with every check, so Settings can show what failed. */

const projectId = z.string().min(1).max(300);
const engineMode = z.enum(["syncthing", "builtin"]);
const checksQuery = z.object({ projectId, engine: engineMode.optional() }).strict();
const engineBody = z.object({ projectId, engine: engineMode }).strict();

app.get("/api/file-sync/projects", (_request, response, next) => answer(response, next, async () => {
  const { fileSyncProjects } = await import("./index.js");
  return fileSyncProjects();
}));

app.get("/api/file-sync/engine/checks", (request, response, next) => answer(response, next, async () => {
  const query = checksQuery.parse(request.query);
  const { fileSyncEngineChecks } = await import("./index.js");
  return fileSyncEngineChecks(query.projectId, query.engine);
}));

app.post("/api/file-sync/engine", async (request, response, next) => {
  try {
    const body = engineBody.parse(request.body ?? {});
    const [{ fileSyncSwitchEngine, FileSyncSwitchRefused }, { actingAccount }] = await Promise.all([import("./index.js"), import("../account-context.js")]);
    // auto-transition: a move back by hand holds the project on Syncthing, in this person's name.
    const account = actingAccount();
    const person = account ? { name: account.username || account.email || account.accountId, id: account.userId ?? account.accountId } : undefined;
    try {
      response.json(await fileSyncSwitchEngine(body.projectId, body.engine, person));
    } catch (error) {
      if (error instanceof FileSyncSwitchRefused) { response.status(409).json({ error: error.message, checks: error.checks }); return; }
      throw error;
    }
  } catch (error) {
    await answer(response, next, () => Promise.reject(error));
  }
});

/* fix: lifts a move back by hand, so the owner moves the project to built-in sync by itself again once
   every check passes; nothing moves now. Only the owner may (409 otherwise). */
const allowBody = z.object({ projectId }).strict();
app.post("/api/file-sync/engine/allow-auto", async (request, response, next) => {
  try {
    const body = allowBody.parse(request.body ?? {});
    const { fileSyncAllowAuto, FileSyncSwitchRefused } = await import("./index.js");
    try {
      response.json(await fileSyncAllowAuto(body.projectId));
    } catch (error) {
      if (error instanceof FileSyncSwitchRefused) { response.status(409).json({ error: error.message, checks: error.checks }); return; }
      throw error;
    }
  } catch (error) {
    await answer(response, next, () => Promise.reject(error));
  }
});

/* Tests only (test/file-sync-builtin-nodes.test.ts): sets a project's node-local phase without the
   switch's checks and bootstrap. Never registered outside NODE_ENV=test with
   JOINT_BOB_FILE_SYNC_TEST_PHASES=1, so a production server has no such route at all. */
if (process.env.NODE_ENV === "test" && process.env.JOINT_BOB_FILE_SYNC_TEST_PHASES === "1") {
  const testPhaseBody = z.object({ projectId: z.string().min(1).max(200), phase: z.enum(["syncthing", "releasing", "bootstrapping", "builtin", "restoring"]) }).strict();
  app.post("/api/file-sync/test-phase", (request, response, next) => answer(response, next, async () => {
    const body = testPhaseBody.parse(request.body ?? {});
    const { fileSyncTestPhase } = await import("./index.js");
    return fileSyncTestPhase(body.projectId, body.phase);
  }));
}
