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
    response.json({ notes: listQuickNotes(project.id) });
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

app.get("/api/quick-notes", (_request, response, next) => {
  try {
    response.json({ notes: listAllQuickNotes() });
  } catch (error) {
    next(error);
  }
});

// Registered after the fixed /queue path so it cannot swallow it.
app.get("/api/quick-notes/:noteId", (request, response, next) => {
  try {
    const note = getQuickNote(request.params.noteId);
    if (!note) { sendError(response, 404, "Quick note not found"); return; }
    response.json({ note });
  } catch (error) {
    next(error);
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
    if (!getQuickNote(request.params.noteId)) { sendError(response, 404, "Quick note not found"); return; }
    const payload = quickNoteSchema.parse(request.body);
    const project = await getProject(payload.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    response.json({ note: updateQuickNote(request.params.noteId, { ...payload, projectId: project.id }) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/quick-notes/:noteId", (request, response, next) => {
  try {
    if (!deleteQuickNote(request.params.noteId)) { sendError(response, 404, "Quick note not found"); return; }
    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

/** Manual start of a saved note: one accepted launch, no duplicate turns. */
app.post("/api/quick-notes/:noteId/start", async (request, response, next) => {
  try {
    const note = await launchQuickNote(request.params.noteId);
    response.json({
      note,
      sessionId: note.sessionId,
      nodeId: note.nodeId ?? (await getClusterNode()).id,
      sessionPath: note.sessionId ? `draft:${note.harnessId}:${note.sessionId}` : null,
    });
  } catch (error) {
    if (error instanceof QuickNoteLaunchError) { sendError(response, error.status, error.message); return; }
    next(error);
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
