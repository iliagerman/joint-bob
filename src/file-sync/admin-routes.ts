import { z } from "zod";
import { sendError } from "../server/http-auth.js";
import { app } from "../server/state.js";
import { fileSyncConfigPatchSchema } from "./control.js";

/* Settings → File sync, for the node's admin only (ADMIN_ROUTES in server/admin.ts). The engine
   loads on first use, so registering these routes adds nothing to the server's startup. */

app.get("/api/file-sync/status", async (_request, response, next) => {
  try {
    const { fileSyncStatus } = await import("./index.js");
    response.json(await fileSyncStatus());
  } catch (error) { next(error); }
});

app.put("/api/file-sync/config", async (request, response, next) => {
  try {
    const patch = fileSyncConfigPatchSchema.parse(request.body ?? {});
    const { applyFileSyncConfig, FileSyncConfigError } = await import("./index.js");
    try { response.json(await applyFileSyncConfig(patch)); }
    catch (error) {
      if (error instanceof FileSyncConfigError) { sendError(response, error.status, error.message); return; }
      throw error;
    }
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, error.errors.map((issue) => issue.message).join(", ")); return; }
    next(error);
  }
});
