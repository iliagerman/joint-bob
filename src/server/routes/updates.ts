import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { appVersion, readChangelog } from "../../changelog.js";
import { ProjectDirectoryImportError } from "../../project-directory-import.js";
import { getClusterNode } from "../../cluster.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { isActiveUpdateTwin } from "../../twin-updates.js";
import { startHarnessUpdates } from "../../harness-updater.js";
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

app.post("/api/update/prepare", (_request, response) => {
  sendError(response, 403, "Legacy update preparation is forbidden");
});

const emptyObjectSchema = z.object({}).strict();

app.post("/api/cluster/v2/update/prepare", async (request, response, next) => {
  try {
    const node = await getClusterNode();
    if (response.locals.machineProtocol !== 2 || response.locals.machineNodeId !== node.id) {
      sendError(response, 403, "Only this node may prepare itself for update");
      return;
    }
    emptyObjectSchema.parse(request.body);
    const recoveryCount = await prepareForUpdate();
    response.json({ ready: true, recoveryCount });
  } catch (error) {
    if (error instanceof UpdateRefusalError) { sendError(response, 409, error.message); return; }
    next(error);
  }
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

app.post("/api/update/harnesses", (_request, response) => {
  startHarnessUpdates();
  response.status(202).json(updateStatusView());
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

app.post("/api/cluster/update/install", (_request, response) => {
  sendError(response, 403, "Legacy remote update installation is forbidden");
});

const remoteInstallSchema = z.object({
  relationshipId: z.string().uuid(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
}).strict();

app.post("/api/cluster/v2/update/install", async (request, response, next) => {
  try {
    const payload = remoteInstallSchema.parse(request.body);
    const [node, database] = await Promise.all([getClusterNode(), clusterV2Database()]);
    const senderNodeId = response.locals.machineNodeId as string;
    if (response.locals.machineProtocol !== 2 || !isActiveUpdateTwin(database, node.id, senderNodeId, payload.relationshipId)) {
      sendError(response, 403, "An active direct twin relationship is required");
      return;
    }
    if (!selfUpdateSupported()) { sendError(response, 409, "Self-update is only available on an installed node, not a development checkout"); return; }
    const release = await releaseForVersion(payload.version);
    if (!isActiveUpdateTwin(database, node.id, senderNodeId, payload.relationshipId)) {
      sendError(response, 403, "An active direct twin relationship is required");
      return;
    }
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
