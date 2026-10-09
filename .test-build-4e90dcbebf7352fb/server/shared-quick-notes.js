import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { ClusterV2HttpError } from "../cluster-v2-errors.js";
import { getQuickNote, listQuickNotes } from "../quick-notes.js";
import { replicationPeers, signedPeerPost } from "./replication-v2.js";
import { mayShareProject, sharedProjectIds } from "./sharing-files.js";
import { quickNoteSchema } from "./schemas.js";
const noteSchema = quickNoteSchema.innerType().extend({
  id: z.string().min(1).max(120),
  status: z.enum(["pending", "starting", "started", "completed", "failed"]),
  error: z.string().nullable(),
  sessionId: z.string().nullable(),
  launchRequestId: z.string().nullable(),
  dispatchedAt: z.string().datetime().nullable().optional().default(null),
  position: z.number().int().optional().default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  provider: z.string().nullable(),
  modelId: z.string().nullable(),
  thinkingLevel: z.string().nullable(),
  nodeId: z.string().uuid().nullable(),
  secretAccountIds: z.array(z.string().uuid()),
  images: z.array(quickNoteSchema.innerType().shape.images.unwrap().element.extend({
    id: z.string().uuid(),
    // A failed note may have lost an image file on its home node.
    data: quickNoteSchema.innerType().shape.images.unwrap().element.shape.data.or(z.literal(""))
  })).max(4),
  scheduledAt: z.string().datetime().nullable()
}).strict();
async function context() {
  const db = await clusterV2Database(), local = await getClusterNode();
  db.exec(`CREATE TABLE IF NOT EXISTS shared_quick_notes (
    owner_node_id TEXT NOT NULL, project_id TEXT NOT NULL, note_id TEXT NOT NULL, note TEXT NOT NULL,
    PRIMARY KEY(owner_node_id, note_id))`);
  const peers = replicationPeers(db, local.id);
  const cached = db.prepare("SELECT DISTINCT owner_node_id, project_id FROM shared_quick_notes").all();
  for (const row of cached) {
    if (!peers.some((peer) => peer.nodeId === row.owner_node_id) || !mayShareProject(db, local.id, row.owner_node_id, row.project_id)) {
      db.prepare("DELETE FROM shared_quick_notes WHERE owner_node_id=? AND project_id=?").run(row.owner_node_id, row.project_id);
    }
  }
  return { db, local, peers };
}
const syncing = /* @__PURE__ */ new Map();
async function syncSharedQuickNotes(projectId) {
  const { db, local, peers } = await context();
  await Promise.all(peers.flatMap((peer) => sharedProjectIds(db, local.id, peer.nodeId).filter((id) => !projectId || id === projectId).map((id) => {
    const key = `${peer.nodeId}:${id}`;
    let pending = syncing.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          const body = await signedPeerPost(peer, "/api/cluster/v2/quick-notes/list", { projectId: id });
          const { notes } = z.object({ notes: z.array(noteSchema) }).strict().parse(body);
          if (notes.some((note) => note.projectId !== id || !["pending", "failed"].includes(note.status)) || new Set(notes.map((note) => note.id)).size !== notes.length) throw new Error("Invalid shared notes snapshot");
          if (!replicationPeers(db, local.id).some((p) => p.nodeId === peer.nodeId) || !mayShareProject(db, local.id, peer.nodeId, id)) return;
          const remoteNotes = notes.filter((note) => !getQuickNote(note.id));
          db.exec("SAVEPOINT shared_notes_snapshot");
          try {
            db.prepare("DELETE FROM shared_quick_notes WHERE owner_node_id=? AND project_id=?").run(peer.nodeId, id);
            const insert = db.prepare("INSERT OR REPLACE INTO shared_quick_notes VALUES(?,?,?,?)");
            for (const note of remoteNotes) insert.run(peer.nodeId, id, note.id, JSON.stringify(note));
            db.exec("RELEASE shared_notes_snapshot");
          } catch (error) {
            db.exec("ROLLBACK TO shared_notes_snapshot; RELEASE shared_notes_snapshot");
            throw error;
          }
        } catch (error) {
          if (error instanceof ClusterV2HttpError && [403, 404].includes(error.statusCode)) {
            db.prepare("DELETE FROM shared_quick_notes WHERE owner_node_id=? AND project_id=?").run(peer.nodeId, id);
          }
        }
      })().finally(() => syncing.delete(key));
      syncing.set(key, pending);
    }
    return pending;
  })));
}
const LIST_WAIT_MS = 1e3;
async function listSharedQuickNotes(projectId) {
  let timer;
  await Promise.race([syncSharedQuickNotes(projectId).catch(() => void 0), new Promise((resolve) => {
    timer = setTimeout(resolve, LIST_WAIT_MS);
  })]);
  clearTimeout(timer);
  const { db } = await context();
  const rows = projectId ? db.prepare("SELECT owner_node_id, note FROM shared_quick_notes WHERE project_id=?").all(projectId) : db.prepare("SELECT owner_node_id, note FROM shared_quick_notes").all();
  return rows.map((row) => {
    const note = JSON.parse(row.note);
    return { ...note, ownerNodeId: row.owner_node_id, nodeId: note.nodeId ?? row.owner_node_id };
  });
}
async function sharedQuickNote(id) {
  const { db, peers } = await context();
  const rows = db.prepare("SELECT owner_node_id, note FROM shared_quick_notes WHERE note_id=?").all(id);
  if (rows.length > 1 || rows.length && getQuickNote(id)) throw new ClusterV2HttpError(409, "Quick note identity is ambiguous");
  const row = rows[0];
  if (!row) return void 0;
  const note = JSON.parse(row.note);
  return { note: { ...note, nodeId: note.nodeId ?? row.owner_node_id }, peer: peers.find((peer) => peer.nodeId === row.owner_node_id) };
}
async function forwardQuickNote(id, action, input) {
  const shared = await sharedQuickNote(id);
  if (!shared) throw new ClusterV2HttpError(404, "Quick note not found");
  const { db, local } = await context();
  if (action === "edit") {
    const payload = quickNoteSchema.parse(input);
    if (!mayShareProject(db, local.id, shared.peer.nodeId, payload.projectId)) throw new ClusterV2HttpError(403, "Destination project is not shared with the note's home node");
  }
  if (action === "move") {
    const { targetId } = z.object({ targetId: z.string().min(1).max(120) }).strict().parse(input);
    const target = await sharedQuickNote(targetId);
    if (!target || target.peer.nodeId !== shared.peer.nodeId) throw new ClusterV2HttpError(409, "Notes have separate home-node queues");
  }
  try {
    const result = await signedPeerPost(shared.peer, "/api/cluster/v2/quick-notes/action", { id, action, ...input ? { input } : {} });
    await syncing.get(`${shared.peer.nodeId}:${shared.note.projectId}`);
    db.prepare("DELETE FROM shared_quick_notes WHERE owner_node_id=? AND note_id=?").run(shared.peer.nodeId, id);
    if (action === "edit") {
      const { note } = z.object({ note: noteSchema }).strict().parse(result);
      if (note.id !== id) throw new Error("Peer returned an unrelated note");
      await authorizeQuickNotePeer(shared.peer.nodeId, note.projectId);
      db.prepare("INSERT OR REPLACE INTO shared_quick_notes VALUES(?,?,?,?)").run(shared.peer.nodeId, note.projectId, id, JSON.stringify(note));
    }
    return result;
  } catch (error) {
    if (error instanceof ClusterV2HttpError) throw error;
    throw new ClusterV2HttpError(503, "Quick note home node unavailable. Action outcome may be uncertain; check before retrying.");
  }
}
async function authorizeQuickNotePeer(peer, projectId) {
  const { db, local, peers } = await context();
  if (!peers.some((candidate) => candidate.nodeId === peer) || !mayShareProject(db, local.id, peer, projectId)) throw new ClusterV2HttpError(403, "Project is not shared with this node");
}
async function offeredQuickNotes(peer, projectId) {
  await authorizeQuickNotePeer(peer, projectId);
  return listQuickNotes(projectId);
}
export {
  authorizeQuickNotePeer,
  forwardQuickNote,
  listSharedQuickNotes,
  offeredQuickNotes,
  sharedQuickNote,
  syncSharedQuickNotes
};
