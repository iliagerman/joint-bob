import { z } from "zod";
import { authorizeQuickNotePeer, forwardQuickNote, listSharedQuickNotes, offeredQuickNotes, sharedQuickNote, syncSharedQuickNotes } from "../shared-quick-notes.js";
import { mapV2Error } from "../cluster-v2.js";
import { secretHiddenFromActor } from "../../secrets.js";
import { getProject, projectVisible } from "../../store.js";
import { NotFoundError } from "../../not-found.js";
import { getClusterNode } from "../../cluster.js";
import { createQuickNote, deleteQuickNote, getQuickNote, getQuickNoteQueue, listAllQuickNotes, listQuickNotes, moveQuickNote, setQuickNoteQueue, updateQuickNote } from "../../quick-notes.js";
import { launchQuickNote, prepareQuickNoteConversation, QuickNoteLaunchError } from "../quick-note-dispatch.js";
import { sendError } from "../http-auth.js";
import { quickNotePrepareSchema, quickNoteQueueSchema, quickNoteSchema } from "../schemas.js";
import { app } from "../state.js";
import { peerMayRunHere } from "../cluster-helpers.js";

/** A note in a project the caller can't see is answered as if it didn't exist, and is never
    looked for on another node either. */
async function visibleLocalNote(noteId: string): Promise<ReturnType<typeof getQuickNote>> {
  const note = getQuickNote(noteId);
  if (note && !await projectVisible(note.projectId)) throw new NotFoundError("Quick note not found");
  return note;
}

async function visibleNotes<T extends { projectId: string }>(notes: T[]): Promise<T[]> {
  const visible = new Map<string, boolean>();
  for (const note of notes) if (!visible.has(note.projectId)) visible.set(note.projectId, await projectVisible(note.projectId));
  return notes.filter((note) => visible.get(note.projectId));
}

const moveSchema = z.object({ targetId: z.string().min(1).max(120) }).strict();
const noteOrder = (a: { position: number; createdAt: string; id: string }, b: { position: number; createdAt: string; id: string }) =>
  (a.position ?? 0) - (b.position ?? 0) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

app.post("/api/quick-notes/:noteId/move", async (request, response, next) => {
  try {
    const input = moveSchema.parse(request.body);
    if (!await visibleLocalNote(request.params.noteId)) {
      response.json(await forwardQuickNote(request.params.noteId, "move", input));
      return;
    }
    await visibleLocalNote(input.targetId);
    try { moveQuickNote(request.params.noteId, input.targetId); }
    catch (error) { sendError(response, 409, (error as Error).message); return; }
    response.json({ ok: true });
  } catch (error) { mapV2Error(error, response, next); }
});

app.get("/api/projects/:projectId/quick-notes", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    response.json({ notes: [...listQuickNotes(project.id), ...await listSharedQuickNotes(project.id)].sort(noteOrder) });
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
    response.json({ notes: (await visibleNotes([...listAllQuickNotes(), ...await listSharedQuickNotes()])).sort(noteOrder) });
  } catch (error) {
    next(error);
  }
});

// Registered after the fixed /queue path so it cannot swallow it.
app.get("/api/quick-notes/:noteId", async (request, response, next) => {
  try {
    const note = await visibleLocalNote(request.params.noteId) ?? (await sharedQuickNote(request.params.noteId))?.note;
    if (!note || !await projectVisible(note.projectId)) { sendError(response, 404, "Quick note not found"); return; }
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
    // A note carries only secrets its writer may use: the queue starts it later, as the node.
    if ((payload.secretAccountIds ?? []).some(secretHiddenFromActor)) { sendError(response, 404, "Secret account not found"); return; }
    response.status(201).json({ note: createQuickNote({ ...payload, projectId: project.id }) });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/quick-notes/:noteId", async (request, response, next) => {
  try {
    const existing = await visibleLocalNote(request.params.noteId);
    if (!existing) {
      response.json(await forwardQuickNote(request.params.noteId, "edit", request.body));
      return;
    }
    if (existing.dispatchedAt) { sendError(response, 409, "This note was already dispatched; open its conversation instead"); return; }
    const payload = quickNoteSchema.parse(request.body);
    const project = await getProject(payload.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    // A note carries only secrets its writer may use: the queue starts it later, as the node.
    if ((payload.secretAccountIds ?? []).some(secretHiddenFromActor)) { sendError(response, 404, "Secret account not found"); return; }
    response.json({ note: updateQuickNote(request.params.noteId, { ...payload, projectId: project.id }) });
  } catch (error) {
    mapV2Error(error, response, next);
  }
});

app.delete("/api/quick-notes/:noteId", async (request, response, next) => {
  try {
    if (!await visibleLocalNote(request.params.noteId)) await forwardQuickNote(request.params.noteId, "delete");
    else deleteQuickNote(request.params.noteId);
    response.status(204).send();
  } catch (error) {
    mapV2Error(error, response, next);
  }
});

/** Manual start of a saved note: one accepted launch, no duplicate turns. */
app.post("/api/quick-notes/:noteId/start", async (request, response, next) => {
  try {
    if (!await visibleLocalNote(request.params.noteId)) {
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

/** A peer saying its drafts for these projects changed. Only projects it shares with this node are fetched, and only from it. */
app.post("/api/cluster/v2/quick-notes/changed", async (request, response, next) => {
  try {
    const { projectIds } = z.object({ projectIds: z.array(z.string().min(1).max(120)).min(1).max(500) }).strict().parse(request.body);
    void syncSharedQuickNotes(projectIds, response.locals.machineNodeId as string).catch((error) => console.warn("Fetching a peer's changed quick notes failed", error));
    response.json({ ok: true });
  } catch (error) { mapV2Error(error, response, next); }
});

app.post("/api/cluster/v2/quick-notes/action", async (request, response, next) => {
  try {
    const payload = z.object({ id: z.string().min(1).max(120), action: z.enum(["edit", "delete", "start", "move"]), input: z.union([quickNoteSchema, moveSchema]).optional() }).strict().parse(request.body);
    const note = getQuickNote(payload.id);
    if (!note) { sendError(response, 404, "Quick note not found"); return; }
    const peer = response.locals.machineNodeId as string;
    await authorizeQuickNotePeer(peer, note.projectId);
    if (getQuickNote(note.id)?.projectId !== note.projectId) { sendError(response, 409, "Quick note changed during authorization"); return; }
    if (payload.action === "edit") {
      if (note.dispatchedAt) { sendError(response, 409, "This note was already dispatched; open its conversation instead"); return; }
      const input = quickNoteSchema.parse(payload.input);
      const project = await getProject(input.projectId);
      if (!project) { sendError(response, 404, "Project not found"); return; }
      await authorizeQuickNotePeer(peer, project.id);
      if (getQuickNote(note.id)?.projectId !== note.projectId) { sendError(response, 409, "Quick note changed during authorization"); return; }
      response.json({ note: updateQuickNote(note.id, { ...input, projectId: project.id }) });
    } else if (payload.action === "move") {
      const { targetId } = moveSchema.parse(payload.input);
      const target = getQuickNote(targetId);
      if (!target) { sendError(response, 409, "Target note is not in this queue"); return; }
      await authorizeQuickNotePeer(peer, target.projectId);
      if (getQuickNote(note.id)?.projectId !== note.projectId || getQuickNote(target.id)?.projectId !== target.projectId) {
        sendError(response, 409, "Quick note changed during authorization"); return;
      }
      try { moveQuickNote(note.id, targetId); }
      catch (error) { sendError(response, 409, (error as Error).message); return; }
      response.json({ ok: true });
    } else if (payload.action === "delete") {
      deleteQuickNote(note.id);
      response.json({ ok: true });
    } else {
      if (!await peerMayRunHere(peer)) { sendError(response, 403, "This node does not accept runs from other nodes"); return; }
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
    if (!await peerMayRunHere(response.locals.machineNodeId)) { sendError(response, 403, "This node does not accept runs from other nodes"); return; }
    const payload = quickNotePrepareSchema.parse(request.body);
    await prepareQuickNoteConversation(payload);
    response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Quick note preparation failed";
    if (/not mapped|not found on the selected node/.test(message)) { sendError(response, 404, message); return; }
    next(error);
  }
});
