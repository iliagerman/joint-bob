import { z } from "zod";
import { authorizeQuickNotePeer, forwardQuickNote, listSharedQuickNotes, offeredQuickNotes, sharedQuickNote } from "../shared-quick-notes.js";
import { mapV2Error } from "../cluster-v2.js";
import { getProject } from "../../store.js";
import { getClusterNode } from "../../cluster.js";
import { createQuickNote, deleteQuickNote, getQuickNote, getQuickNoteQueue, listAllQuickNotes, listQuickNotes, setQuickNoteQueue, updateQuickNote } from "../../quick-notes.js";
import { launchQuickNote, prepareQuickNoteConversation, QuickNoteLaunchError } from "../quick-note-dispatch.js";
import { sendError } from "../http-auth.js";
import { quickNotePrepareSchema, quickNoteQueueSchema, quickNoteSchema } from "../schemas.js";
import { app } from "../state.js";

app.get("/api/projects/:projectId/quick-notes", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    response.json({ notes: [...listQuickNotes(project.id), ...await listSharedQuickNotes(project.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/quick-notes/queue", (_request, response, next) => {
  try {
    response.json({ queue: getQuickNoteQueue() });
  } catch (error) {
    next(error);
  }
});

app.put("/api/quick-notes/queue", async (request, response, next) => {
  try {
    const payload = quickNoteQueueSchema.parse(request.body);
    response.json({ queue: setQuickNoteQueue(payload.queue) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/quick-notes", async (_request, response, next) => {
  try {
    response.json({ notes: [...listAllQuickNotes(), ...await listSharedQuickNotes()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) });
  } catch (error) {
    next(error);
  }
});

// Registered after the fixed /queue path so it cannot swallow it.
app.get("/api/quick-notes/:noteId", async (request, response, next) => {
  try {
    const note = getQuickNote(request.params.noteId) ?? (await sharedQuickNote(request.params.noteId))?.note;
    if (!note) { sendError(response, 404, "Quick note not found"); return; }
    response.json({ note });
  } catch (error) {
    mapV2Error(error, response, next);
  }
});

app.post("/api/quick-notes", async (request, response, next) => {
  try {
    const payload = quickNoteSchema.parse(request.body);
    const project = await getProject(payload.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    response.status(201).json({ note: createQuickNote({ ...payload, projectId: project.id }) });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/quick-notes/:noteId", async (request, response, next) => {
  try {
    if (!getQuickNote(request.params.noteId)) {
      response.json(await forwardQuickNote(request.params.noteId, "edit", request.body));
      return;
    }
    const payload = quickNoteSchema.parse(request.body);
    const project = await getProject(payload.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    response.json({ note: updateQuickNote(request.params.noteId, { ...payload, projectId: project.id }) });
  } catch (error) {
    mapV2Error(error, response, next);
  }
});

app.delete("/api/quick-notes/:noteId", async (request, response, next) => {
  try {
    if (!getQuickNote(request.params.noteId)) await forwardQuickNote(request.params.noteId, "delete");
    else deleteQuickNote(request.params.noteId);
    response.status(204).send();
  } catch (error) {
    mapV2Error(error, response, next);
  }
});

/** Manual start of a saved note: one accepted launch, no duplicate turns. */
app.post("/api/quick-notes/:noteId/start", async (request, response, next) => {
  try {
    if (!getQuickNote(request.params.noteId)) {
      response.json(await forwardQuickNote(request.params.noteId, "start"));
      return;
    }
    const note = await launchQuickNote(request.params.noteId);
    response.json({
      note,
      sessionId: note.sessionId,
      nodeId: note.nodeId ?? (await getClusterNode()).id,
      sessionPath: note.sessionId ? `draft:${note.harnessId}:${note.sessionId}` : null,
    });
  } catch (error) {
    if (error instanceof QuickNoteLaunchError) { sendError(response, error.status, error.message); return; }
    mapV2Error(error, response, next);
  }
});

app.post("/api/cluster/v2/quick-notes/list", async (request, response, next) => {
  try {
    const { projectId } = z.object({ projectId: z.string().min(1).max(120) }).strict().parse(request.body);
    response.json({ notes: await offeredQuickNotes(response.locals.machineNodeId, projectId) });
  } catch (error) { mapV2Error(error, response, next); }
});

app.post("/api/cluster/v2/quick-notes/action", async (request, response, next) => {
  try {
    const payload = z.object({ id: z.string().min(1).max(120), action: z.enum(["edit", "delete", "start"]), input: quickNoteSchema.optional() }).strict().parse(request.body);
    const note = getQuickNote(payload.id);
    if (!note) { sendError(response, 404, "Quick note not found"); return; }
    const peer = response.locals.machineNodeId as string;
    await authorizeQuickNotePeer(peer, note.projectId);
    if (getQuickNote(note.id)?.projectId !== note.projectId) { sendError(response, 409, "Quick note changed during authorization"); return; }
    if (payload.action === "edit") {
      const input = quickNoteSchema.parse(payload.input);
      const project = await getProject(input.projectId);
      if (!project) { sendError(response, 404, "Project not found"); return; }
      await authorizeQuickNotePeer(peer, project.id);
      if (getQuickNote(note.id)?.projectId !== note.projectId) { sendError(response, 409, "Quick note changed during authorization"); return; }
      response.json({ note: updateQuickNote(note.id, { ...input, projectId: project.id }) });
    } else if (payload.action === "delete") {
      deleteQuickNote(note.id);
      response.json({ ok: true });
    } else {
      const launched = await launchQuickNote(note.id);
      response.json({ note: launched, sessionId: launched.sessionId, nodeId: launched.nodeId ?? (await getClusterNode()).id,
        sessionPath: launched.sessionId ? `draft:${launched.harnessId}:${launched.sessionId}` : null });
    }
  } catch (error) {
    if (error instanceof QuickNoteLaunchError) { sendError(response, error.status, error.message); return; }
    mapV2Error(error, response, next);
  }
});

/** A peer asks this node to host a quick note launch it was selected for. */
app.post("/api/cluster/quick-notes/prepare", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = quickNotePrepareSchema.parse(request.body);
    await prepareQuickNoteConversation(payload);
    response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Quick note preparation failed";
    if (/not mapped|not found on the selected node/.test(message)) { sendError(response, 404, message); return; }
    next(error);
  }
});
