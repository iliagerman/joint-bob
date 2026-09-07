import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { appVersion, readChangelog } from "../../changelog.js";
import { ProjectDirectoryImportError } from "../../project-directory-import.js";
import { checkForLatestRelease, installLocalRelease, latestFleetRun, ReleaseFeedError, releaseForVersion, selfUpdateSupported, setAutoUpdate, startFleetUpdate, UpdateRefusalError, updateStatusView } from "../../updater.js";
import { WorkspaceError } from "../../store.js";
import { TaskWorkspaceError } from "../../task-workspaces.js";
import { TaskWorktreeError } from "../../worktrees.js";
import { sendError } from "../http-auth.js";
import { ProjectLockedError } from "../projects.js";
import { prepareForUpdate } from "../realtime.js";
import { app } from "../state.js";

app.get("/api/changelog", (_request, response) => {
  response.json({ version: appVersion(), entries: readChangelog() });
});

app.post("/api/update/prepare", async (_request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const recoveryCount = await prepareForUpdate();
    response.json({ ready: true, recoveryCount });
  } catch (error) { next(error); }
});

const updateStatusResponse = (response: Response): void => {
  response.json(updateStatusView());
};

app.get("/api/update/status", (_request, response) => {
  updateStatusResponse(response);
});

app.post("/api/update/check", async (_request, response, next) => {
  try {
    await checkForLatestRelease(true);
    updateStatusResponse(response);
  } catch (error) { next(error); }
});

const updateSettingsSchema = z.object({ autoUpdate: z.boolean() }).strict();

app.put("/api/update/settings", (request, response, next) => {
  try {
    const payload = updateSettingsSchema.parse(request.body);
    if (!selfUpdateSupported()) { sendError(response, 409, "Self-update is only available on an installed node, not a development checkout"); return; }
    setAutoUpdate(payload.autoUpdate);
    updateStatusResponse(response);
  } catch (error) { next(error); }
});

const installSchema = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/).optional() }).strict();

app.post("/api/update/install", async (request, response, next) => {
  try {
    if (!selfUpdateSupported()) { sendError(response, 409, "Self-update is only available on an installed node, not a development checkout"); return; }
    const payload = installSchema.parse(request.body);
    const release = payload.version
      ? await releaseForVersion(payload.version)
      : (await checkForLatestRelease(false)).release;
    if (!release) { sendError(response, 502, "No release is available from the update feed"); return; }
    const job = installLocalRelease(release);
    response.status(202).json({ job, status: updateStatusView() });
  } catch (error) {
    if (error instanceof ReleaseFeedError) { sendError(response, 502, error.message); return; }
    if (error instanceof UpdateRefusalError) { sendError(response, 409, error.message); return; }
    next(error);
  }
});

app.post("/api/update/install-all", async (_request, response, next) => {
  try {
    const run = await startFleetUpdate();
    response.status(202).json(run);
  } catch (error) {
    if (error instanceof ReleaseFeedError) { sendError(response, 502, error.message); return; }
    if (error instanceof UpdateRefusalError) { sendError(response, 409, error.message); return; }
    next(error);
  }
});

app.get("/api/update/install-all", (_request, response) => {
  response.json(latestFleetRun());
});

/** Machine-authenticated fleet entry point: a coordinator peer asks this node to update itself.
 * The cluster machine token is node-level trust, the same credential that already lets a peer
 * push replication batches and run task handoffs here; project grants scope data visibility,
 * not node management. The release is still resolved from the feed server-side, never from
 * the caller's payload. */
app.post("/api/cluster/update/install", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    if (!selfUpdateSupported()) { sendError(response, 409, "Self-update is only available on an installed node, not a development checkout"); return; }
    const payload = installSchema.parse(request.body);
    if (!payload.version) { sendError(response, 400, "A target version is required"); return; }
    // The peer resolves the release from the feed itself; caller input never carries URLs.
    const release = await releaseForVersion(payload.version);
    const job = installLocalRelease(release);
    response.status(202).json({ accepted: true, jobId: job.id, targetVersion: job.targetVersion });
  } catch (error) {
    if (error instanceof ReleaseFeedError) { sendError(response, 502, error.message); return; }
    if (error instanceof UpdateRefusalError) { sendError(response, 409, error.message); return; }
    next(error);
  }
});

app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) {
    sendError(response, 400, error.errors.map((issue) => issue.message).join(", "));
    return;
  }
  const message = error instanceof Error ? error.message : "Unexpected server error";
  if (error instanceof WorkspaceError) {
    sendError(response, 400, message);
    return;
  }
  const conflict = error instanceof TaskWorktreeError || error instanceof TaskWorkspaceError || error instanceof ProjectDirectoryImportError || error instanceof ProjectLockedError;
  if (!conflict) console.error(`Unhandled ${request.method} ${request.path} error`, error);
  sendError(response, conflict ? 409 : 500, message);
});
