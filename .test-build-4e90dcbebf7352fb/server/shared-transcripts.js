import { projectAdditionalPaths } from "./session-scope.js";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { signClusterRequest } from "../cluster-protocol.js";
import { ClusterV2HttpError } from "../cluster-v2-errors.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { clearHarnessSessionCache, getHarness, harnessForSessionPath, listHarnessSessions } from "../harnesses.js";
import { getProject } from "../store.js";
import { listTasks } from "../tasks.js";
import { getConversationOwnership } from "../conversation-ownership.js";
import { deletedConversationKeys, ensureConversationRecord, ensureConversationRecordSchema } from "../conversation-records.js";
import { replicationPeers } from "./replication-v2.js";
import { mayShareProject, sharedProjectIds } from "./sharing-files.js";
import { fetchPeer, isPeerUnreachable, whilePeerOptional } from "./peer-availability.js";
const transcriptQuery = z.object({ projectId: z.string().min(1).max(300), engine: z.string().min(1).max(80).optional(), sessionId: z.string().min(1).max(300).optional() }).strict();
const entrySchema = z.object({ engine: z.string().min(1).max(80), sessionId: z.string().min(1).max(300), relativePath: z.string().min(1).max(4096), size: z.number().int().min(0).max(1024 * 1024 * 1024), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const inventorySchema = z.object({ entries: z.array(entrySchema).max(1e4) }).strict();
function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS cluster_v2_transcript_receipts(peer_id TEXT NOT NULL,project_id TEXT NOT NULL,engine TEXT NOT NULL,session_id TEXT NOT NULL,path TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(peer_id,project_id,engine,session_id));
 CREATE TABLE IF NOT EXISTS cluster_v2_transcript_progress(peer_id TEXT NOT NULL,project_id TEXT NOT NULL,PRIMARY KEY(peer_id,project_id));
 CREATE TABLE IF NOT EXISTS cluster_v2_transcript_errors(peer_id TEXT NOT NULL,project_id TEXT NOT NULL,error TEXT NOT NULL,PRIMARY KEY(peer_id,project_id));
 CREATE TABLE IF NOT EXISTS transcript_hashes(file TEXT PRIMARY KEY,mtime_ms REAL NOT NULL,size INTEGER NOT NULL,hash TEXT NOT NULL);`);
}
function within(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
const hashCache = /* @__PURE__ */ new Map();
async function fileHash(file, info) {
  const db = await clusterV2Database();
  ensureSchema(db);
  const row = hashCache.get(file) ?? db.prepare("SELECT mtime_ms mtimeMs,size,hash FROM transcript_hashes WHERE file=?").get(file);
  if (row && row.mtimeMs === info.mtimeMs && row.size === info.size) {
    hashCache.set(file, row);
    return row.hash;
  }
  const hash = createHash("sha256");
  let bytes = 0;
  if (info.size > 0) for await (const chunk of createReadStream(file, { start: 0, end: info.size - 1 })) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  if (bytes !== info.size) throw new Error("Transcript changed during hashing");
  const digest = hash.digest("hex");
  hashCache.set(file, { mtimeMs: info.mtimeMs, size: info.size, hash: digest });
  db.prepare("INSERT INTO transcript_hashes VALUES(?,?,?,?) ON CONFLICT(file) DO UPDATE SET mtime_ms=excluded.mtime_ms,size=excluded.size,hash=excluded.hash").run(file, info.mtimeMs, info.size, digest);
  return digest;
}
async function sharedTranscriptProject(peer, id) {
  const db = await clusterV2Database(), local = await getClusterNode();
  if (!mayShareProject(db, local.id, peer, id)) throw new ClusterV2HttpError(403, "Project is not shared with this node");
  const project = await getProject(id);
  if (!project) throw new ClusterV2HttpError(404, "Project not found");
  return project;
}
async function sourceTranscripts(peer, projectId) {
  const project = await sharedTranscriptProject(peer, projectId), sessions = await listHarnessSessions({ ...project, additionalPaths: await projectAdditionalPaths(projectId) });
  const local = await getClusterNode();
  const entries = sessions.flatMap((session) => session.segments?.length ? session.segments.map((segment) => ({ engine: segment.engine, id: segment.sessionId, path: segment.path })) : [{ engine: session.harnessId, id: session.id, path: session.path, subagent: Boolean(session.parentSessionPath) }]);
  for (const task of await listTasks(projectId)) {
    if (!task.sessionPath || task.sessionPath === "watch" || task.currentNodeId !== local.id) continue;
    const adapter = harnessForSessionPath(task.sessionPath), id = adapter.paths.sessionId(task.sessionPath);
    if (!id) throw new Error("Task conversation has no transcript identity");
    entries.push({ engine: adapter.id, id, path: task.sessionPath });
  }
  const deleted = await deletedConversationKeys(projectId);
  const unique = [...new Map(entries.filter((entry) => !entry.path.startsWith("draft:") && !deleted.has(`${entry.engine}:${entry.id}`)).map((entry) => [`${entry.engine}:${entry.id}`, entry])).values()];
  for (const entry of unique) if (!entry.subagent) await ensureConversationRecord(projectId, entry.engine, entry.id, local.id);
  return unique;
}
async function sharedTranscriptFile(peer, projectId, engine, sessionId) {
  const session = (await sourceTranscripts(peer, projectId)).find((row) => row.engine === engine && row.id === sessionId);
  if (!session) throw new ClusterV2HttpError(404, "Conversation not found in shared project");
  return localTranscriptFile(session);
}
async function localTranscriptFile(session) {
  const adapter = getHarness(session.engine), file = adapter.paths.transcriptFile?.(session.path);
  if (!file || !within(adapter.sync.transcriptRoot(), file)) throw new ClusterV2HttpError(409, "Conversation transcript is not available");
  if (!(await lstat(file)).isFile() || !within(await realpath(adapter.sync.transcriptRoot()), await realpath(file))) throw new ClusterV2HttpError(409, "Conversation transcript is not a regular local file");
  return file;
}
async function sharedTranscriptInventory(peer, projectId, only) {
  const entries = [];
  for (const session of await sourceTranscripts(peer, projectId)) {
    if (session.path.startsWith("draft:")) continue;
    if (only && (session.engine !== only.engine || session.id !== only.sessionId)) continue;
    const adapter = getHarness(session.engine), file = await localTranscriptFile(session), info = await stat(file);
    entries.push(entrySchema.parse({ engine: session.engine, sessionId: session.id, relativePath: path.relative(adapter.sync.transcriptRoot(), file), size: info.size, hash: await fileHash(file, info) }));
  }
  return entries;
}
async function peerGet(peer, target, headers = {}) {
  const db = await clusterV2Database(), local = await getClusterNode();
  const response = await fetchPeer(db, peer.nodeId, new URL(target, peer.url), { redirect: "error", signal: AbortSignal.timeout(3e4), headers: { ...headers, Authorization: signClusterRequest(db, local.id, peer.nodeId, "GET", target, Buffer.alloc(0)) } });
  if (!response.ok) throw new Error(`Transcript request rejected (${response.status})`);
  return response;
}
async function safeParent(root, destination) {
  await mkdir(root, { recursive: true });
  let current = root;
  for (const segment of path.relative(root, path.dirname(destination)).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      await mkdir(current);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Transcript parent is not a local directory");
  }
}
async function extendsTranscript(existing, incoming, size) {
  const left = await open(existing, "r"), right = await open(incoming, "r");
  try {
    const a = Buffer.alloc(65536), b = Buffer.alloc(65536);
    for (let offset = 0; offset < size; offset += 65536) {
      const length = Math.min(65536, size - offset);
      const old = await left.read(a, 0, length, offset), next = await right.read(b, 0, length, offset);
      if (old.bytesRead !== length || next.bytesRead !== length || !a.subarray(0, length).equals(b.subarray(0, length))) throw new Error("Divergent transcript requires review");
    }
  } finally {
    await left.close();
    await right.close();
  }
}
const activeReceives = /* @__PURE__ */ new Map();
function receiveTranscript(db, peer, projectId, entry) {
  const key = JSON.stringify([peer.nodeId, projectId, entry.engine, entry.sessionId]);
  const run = (activeReceives.get(key) ?? Promise.resolve()).then(() => receiveTranscriptNow(db, peer, projectId, entry));
  const settled = run.catch(() => void 0).finally(() => {
    if (activeReceives.get(key) === settled) activeReceives.delete(key);
  });
  activeReceives.set(key, settled);
  return run;
}
async function receiveTranscriptNow(db, peer, projectId, entry) {
  const adapter = getHarness(entry.engine), root = path.resolve(adapter.sync.transcriptRoot()), destination = path.resolve(root, entry.relativePath);
  if (!within(root, destination) || !adapter.paths.ownsTranscript(destination) || (adapter.paths.sessionId(destination) ?? adapter.paths.sessionId(`${entry.engine}:${destination}`)) !== entry.sessionId) throw new Error("Invalid shared transcript identity");
  const receipt = db.prepare("SELECT path,hash FROM cluster_v2_transcript_receipts WHERE peer_id=? AND project_id=? AND engine=? AND session_id=?").get(peer.nodeId, projectId, entry.engine, entry.sessionId);
  const ownership = await getConversationOwnership(entry.engine, entry.sessionId);
  if (ownership && ownership.ownerNodeId !== peer.nodeId) return;
  const existing = await lstat(destination).catch((error) => {
    if (error.code === "ENOENT") return void 0;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("Shared transcript destination is not a regular file");
  const localHash = existing ? await fileHash(destination, existing) : void 0;
  if (existing && receipt?.path === destination && receipt.hash === entry.hash && localHash === entry.hash) return;
  await safeParent(root, destination);
  const target = "/api/cluster/v2/transcripts/file?" + new URLSearchParams({ projectId, engine: entry.engine, sessionId: entry.sessionId });
  let source = Readable.from([]);
  if (entry.size > 0) {
    const response = await peerGet(peer, target, { Range: `bytes=0-${entry.size - 1}` });
    if (!response.body) throw new Error("Empty transcript response");
    source = Readable.fromWeb(response.body);
  }
  const temporary = `${destination}.${randomUUID()}.tmp`, hash = createHash("sha256");
  let bytes = 0;
  try {
    await pipeline(source, new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > entry.size) {
        callback(new Error("Transcript exceeds advertised size"));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    } }), createWriteStream(temporary, { flags: "wx", mode: 384 }));
    if (bytes !== entry.size || hash.digest("hex") !== entry.hash) throw new Error("Transcript changed during transfer");
    if (existing && (!ownership || receipt?.hash !== localHash)) {
      await extendsTranscript(destination, temporary, Math.min(existing.size, entry.size));
      if (existing.size > entry.size) return;
    }
    if (existing) {
      const current = await stat(destination);
      if (current.size !== existing.size || current.mtimeMs !== existing.mtimeMs) throw new Error("Local transcript changed during transfer");
    }
    await sharedTranscriptProject(peer.nodeId, projectId);
    if ((await deletedConversationKeys(projectId)).has(`${entry.engine}:${entry.sessionId}`)) return;
    await rename(temporary, destination);
    db.prepare("INSERT OR REPLACE INTO cluster_v2_transcript_receipts VALUES(?,?,?,?,?,?)").run(peer.nodeId, projectId, entry.engine, entry.sessionId, destination, entry.hash);
    clearHarnessSessionCache(projectId);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function assertSharedTranscriptReady(projectId, sessionPath, ownerNodeId) {
  const db = await clusterV2Database(), local = await getClusterNode();
  ensureSchema(db);
  const adapter = harnessForSessionPath(sessionPath), sessionId = adapter.paths.sessionId(sessionPath);
  if (!sessionId) throw new Error("Conversation has no transcript identity");
  const ownership = await getConversationOwnership(adapter.id, sessionId);
  const sourceId = ownerNodeId ?? ownership?.ownerNodeId;
  if (!sourceId || sourceId === local.id) return;
  const peer = replicationPeers(db, local.id).find((peer2) => peer2.nodeId === sourceId);
  if (!peer || !mayShareProject(db, local.id, peer.nodeId, projectId)) throw new Error("Conversation owner is unavailable");
  const target = "/api/cluster/v2/transcripts?" + new URLSearchParams({ projectId });
  const payload = inventorySchema.parse(await (await peerGet(peer, target)).json());
  const entry = payload.entries.find((entry2) => entry2.engine === adapter.id && entry2.sessionId === sessionId);
  if (!entry) throw new Error("Conversation transcript is not available on its owner");
  await receiveTranscript(db, peer, projectId, entry);
  const receipt = db.prepare("SELECT path,hash FROM cluster_v2_transcript_receipts WHERE peer_id=? AND project_id=? AND engine=? AND session_id=?").get(peer.nodeId, projectId, entry.engine, entry.sessionId);
  if (!receipt || receipt.hash !== entry.hash || await fileHash(receipt.path, await stat(receipt.path)) !== entry.hash) throw new Error("Conversation transcript is not synchronized on this node");
}
const activeCatchUps = /* @__PURE__ */ new Map();
function catchUpSharedTranscript(peerId, engine, sessionId) {
  const key = JSON.stringify([peerId, engine, sessionId]), active = activeCatchUps.get(key);
  if (active) return active;
  const run = catchUpSharedTranscriptNow(peerId, engine, sessionId).finally(() => activeCatchUps.delete(key));
  activeCatchUps.set(key, run);
  return run;
}
async function catchUpSharedTranscriptNow(peerId, engine, sessionId) {
  const db = await clusterV2Database(), local = await getClusterNode();
  ensureSchema(db);
  ensureConversationRecordSchema(db);
  const peer = replicationPeers(db, local.id).find((peer2) => peer2.nodeId === peerId);
  if (!peer) return;
  const projects = db.prepare("SELECT DISTINCT project_id FROM conversation_records WHERE engine=? AND session_id=?").all(engine, sessionId);
  for (const { project_id: projectId } of projects) {
    if (!mayShareProject(db, local.id, peer.nodeId, projectId) || !await getProject(projectId)) continue;
    const target = "/api/cluster/v2/transcripts?" + new URLSearchParams({ projectId, engine, sessionId });
    const entry = inventorySchema.parse(await (await peerGet(peer, target)).json()).entries.find((entry2) => entry2.engine === engine && entry2.sessionId === sessionId);
    if (entry) await receiveTranscript(db, peer, projectId, entry);
  }
}
let activeFlush;
function flushSharedTranscripts() {
  if (!activeFlush) activeFlush = runSharedTranscripts().finally(() => {
    activeFlush = void 0;
  });
  return activeFlush;
}
function sharedTranscriptStatus(db, local, peer) {
  ensureSchema(db);
  const projects = sharedProjectIds(db, local, peer);
  const errors = db.prepare("SELECT project_id,error FROM cluster_v2_transcript_errors WHERE peer_id=?").all(peer);
  const failure = errors.find((error) => projects.includes(error.project_id));
  const pending = projects.filter((id) => !db.prepare("SELECT 1 FROM cluster_v2_transcript_progress WHERE peer_id=? AND project_id=?").get(peer, id)).length;
  return { pending, ...failure ? { error: failure.error } : {} };
}
const PULL_INTERVAL_MS = 3e4;
const pulledAt = /* @__PURE__ */ new Map();
function resetSharedTranscriptPulls() {
  pulledAt.clear();
}
async function runSharedTranscripts() {
  const db = await clusterV2Database(), local = await getClusterNode();
  ensureSchema(db);
  for (const peer of replicationPeers(db, local.id)) for (const projectId of sharedProjectIds(db, local.id, peer.nodeId)) try {
    if (!await getProject(projectId)) continue;
    const key = `${peer.nodeId}
${projectId}`;
    if (Date.now() - (pulledAt.get(key) ?? 0) < PULL_INTERVAL_MS) continue;
    pulledAt.set(key, Date.now());
    const target = "/api/cluster/v2/transcripts?" + new URLSearchParams({ projectId });
    const payload = inventorySchema.parse(await (await whilePeerOptional(() => peerGet(peer, target))).json());
    let failure;
    for (const entry of payload.entries) try {
      await receiveTranscript(db, peer, projectId, entry);
    } catch (error) {
      failure ??= error;
      if (isPeerUnreachable(error)) break;
    }
    if (failure) throw failure;
    db.prepare("DELETE FROM cluster_v2_transcript_errors WHERE peer_id=? AND project_id=?").run(peer.nodeId, projectId);
    db.prepare("INSERT OR IGNORE INTO cluster_v2_transcript_progress VALUES(?,?)").run(peer.nodeId, projectId);
  } catch (error) {
    db.prepare("INSERT OR REPLACE INTO cluster_v2_transcript_errors VALUES(?,?,?)").run(peer.nodeId, projectId, error instanceof Error ? error.message : "Transcript transfer failed");
  }
}
export {
  assertSharedTranscriptReady,
  catchUpSharedTranscript,
  flushSharedTranscripts,
  resetSharedTranscriptPulls,
  sharedTranscriptFile,
  sharedTranscriptInventory,
  sharedTranscriptProject,
  sharedTranscriptStatus,
  transcriptQuery
};
