import { createQuickNote, deleteQuickNote, getQuickNote, listQuickNotes, updateQuickNote } from "../../quick-notes.js";
import { getProject } from "../../store.js";
import { sendError } from "../http-auth.js";
import { quickNoteSchema } from "../schemas.js";
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
