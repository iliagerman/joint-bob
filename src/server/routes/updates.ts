import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { appVersion, readChangelog } from "../../changelog.js";
import { ProjectDirectoryImportError } from "../../project-directory-import.js";
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

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) {
    sendError(response, 400, error.errors.map((issue) => issue.message).join(", "));
    return;
  }
  const message = error instanceof Error ? error.message : "Unexpected server error";
  if (error instanceof WorkspaceError) {
    sendError(response, 400, message);
    return;
  }
  sendError(response, error instanceof TaskWorktreeError || error instanceof TaskWorkspaceError || error instanceof ProjectDirectoryImportError || error instanceof ProjectLockedError ? 409 : 500, message);
});
