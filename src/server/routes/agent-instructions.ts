import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { Request, Response } from "express";
import { z } from "zod";
import { getClusterNode } from "../../cluster.js";
import { ABSENT_VERSION, INSTRUCTIONS_LIMIT, InstructionsConflict, instructionsVersion, readGlobalInstructions, readOptionalText, saveGlobalInstructions, writeTextAtomically } from "../../global-instructions.js";
import { projectInstructionFile, projectInstructionSources } from "../../project-folder-resources.js";
import { getProjectWorktree } from "../../project-worktrees.js";
import { getProject } from "../../store.js";
import { listTasks } from "../../tasks.js";
import { sendError } from "../http-auth.js";
import { assertProjectEditable } from "../projects.js";
import { instructionsChanged } from "../realtime.js";
import { getRuntimePeer, runtimeFetch } from "../runtime-peers.js";
import { app } from "../state.js";
import { ProjectFileError, resolutionRoot } from "./project-files.js";

// The file editor sends the conversation it was opened from; instructions do not need one.
const updateSchema = z.object({ content: z.string(), version: z.string().min(1).max(100), sessionId: z.string().max(300).optional() }).strict();
type Update = z.infer<typeof updateSchema>;
type Where = { taskId?: string; worktreeId?: string };

function sendInstructionsError(response: Response, error: unknown): boolean {
  if (error instanceof InstructionsConflict) sendError(response, 409, error.message);
  else if (error instanceof RangeError) sendError(response, 413, error.message);
  else if (error instanceof ProjectFileError) sendError(response, error.status, error.message);
  else return false;
  return true;
}

/** The folder the conversation's agent runs in: a worktree, a ticket workspace or the project itself. */
async function instructionsRoot(projectId: string, where: Where) {
  const project = await getProject(projectId);
  if (!project) throw new ProjectFileError(404, "Project not found");
  if (where.worktreeId) {
    const worktree = await getProjectWorktree(project.id, where.worktreeId);
    if (!worktree) throw new ProjectFileError(404, "Worktree is not available on this node");
    return { project, root: await realpath(worktree.path) };
  }
  return { project, root: await resolutionRoot(project.id, project.path, where.taskId) };
}

async function projectInstructions(projectId: string, where: Where) {
  const { root } = await instructionsRoot(projectId, where);
  const file = projectInstructionFile(root);
  const content = file ? readOptionalText(file) : undefined;
  if (content !== undefined && Buffer.byteLength(content) > INSTRUCTIONS_LIMIT) throw new ProjectFileError(413, `${path.basename(file!)} is too large to edit`);
  // The other files agents read from the project folder, beside the one edited here.
  const others = projectInstructionSources(root).map((source) => source.relative).filter((relative) => !file || relative !== path.basename(file));
  return { path: file ? path.basename(file) : "AGENTS.md", content: content ?? "", version: instructionsVersion(content), exists: content !== undefined, others };
}

/** Writes the file agents read, the project's AGENTS.md, or its CLAUDE.md when that is all it has. */
async function saveProjectInstructions(projectId: string, where: Where, update: Update) {
  const { project, root } = await instructionsRoot(projectId, where);
  await assertProjectEditable(project);
  if (Buffer.byteLength(update.content) > INSTRUCTIONS_LIMIT) throw new RangeError("AGENTS.md is too large");
  const current = projectInstructionFile(root);
  if (instructionsVersion(current ? readOptionalText(current) : undefined) !== update.version) {
    throw new InstructionsConflict(update.version === ABSENT_VERSION ? "The project got an AGENTS.md since this was opened" : `${path.basename(current ?? "AGENTS.md")} changed since it was opened`);
  }
  // A linked file is written where it points, which must still be inside the project.
  const target = current ? realpathSync(current) : path.join(root, "AGENTS.md");
  if (!target.startsWith(root + path.sep)) throw new ProjectFileError(403, "The instructions file points outside the project");
  writeTextAtomically(target, update.content);
  instructionsChanged();
  return { path: path.basename(current ?? target), version: instructionsVersion(update.content) };
}

function where(request: Request): Where {
  return {
    ...(typeof request.query.taskId === "string" && request.query.taskId ? { taskId: request.query.taskId } : {}),
    ...(typeof request.query.worktreeId === "string" && request.query.worktreeId ? { worktreeId: request.query.worktreeId } : {}),
  };
}

app.get("/api/instructions/global/content", (_request, response) => {
  response.json(readGlobalInstructions());
});

app.put("/api/instructions/global/content", async (request, response, next) => {
  try {
    const update = updateSchema.parse(request.body);
    const saved = saveGlobalInstructions(update.content, update.version, (await getClusterNode()).id);
    instructionsChanged();
    response.json(saved);
  } catch (error) { if (!sendInstructionsError(response, error)) next(error); }
});

async function sendProjectInstructions(response: Response, projectId: string, location: Where, update?: Update): Promise<void> {
  try { response.json(update ? await saveProjectInstructions(projectId, location, update) : await projectInstructions(projectId, location)); }
  catch (error) { if (!sendInstructionsError(response, error)) throw error; }
}

for (const method of ["get", "put"] as const) {
  // The node the conversation runs on holds its worktree or ticket workspace; its project folder syncs.
  app[method]("/api/cluster/project-instructions-content", async (request, response, next) => {
    try {
      if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
      await sendProjectInstructions(response, String(request.query.projectId ?? ""), where(request), method === "put" ? updateSchema.parse(request.body) : undefined);
    } catch (error) { next(error); }
  });

  app[method]("/api/projects/:projectId/instructions/content", async (request, response, next) => {
    try {
      const location = where(request);
      let nodeId = typeof request.query.nodeId === "string" ? request.query.nodeId : "";
      if (location.taskId) nodeId = (await listTasks(request.params.projectId)).find((task) => task.id === location.taskId)?.currentNodeId ?? nodeId;
      const update = method === "put" ? updateSchema.parse(request.body) : undefined;
      if (nodeId && nodeId !== (await getClusterNode()).id) {
        const peer = await getRuntimePeer(nodeId);
        if (!peer) { sendError(response, 404, "The conversation's node was not found"); return; }
        const url = new URL("/api/cluster/project-instructions-content", peer.url);
        url.searchParams.set("projectId", request.params.projectId);
        for (const [key, value] of Object.entries(location)) url.searchParams.set(key, value);
        const routed = await runtimeFetch(url, { method: method.toUpperCase(), headers: update ? { "Content-Type": "application/json" } : {}, ...(update ? { body: JSON.stringify(update) } : {}), signal: AbortSignal.timeout(30_000) });
        response.status(routed.status).type(routed.headers.get("content-type") ?? "application/json").send(await routed.text());
        return;
      }
      await sendProjectInstructions(response, request.params.projectId, location, update);
    } catch (error) { if (!sendInstructionsError(response, error)) next(error); }
  });
}
