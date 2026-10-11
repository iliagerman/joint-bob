import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs, { appendFileSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import express from "express";
import { getClusterNode } from "../src/cluster.js";
import { recordPeerEndpoint } from "../src/cluster-peer-endpoints.js";
import { verifyClusterRequest } from "../src/cluster-protocol.js";
import { clusterV2Database } from "../src/cluster-v2-store.js";
import { applyTwinCertificate, confirmTwinAcceptance, createTwinInvitation, prepareTwinAcceptance } from "../src/cluster-twins.js";
import { ensureConversationRecord } from "../src/conversation-records.js";
import { getHarness } from "../src/harnesses.js";
import { markPeerReachable, resetPeerAvailability } from "../src/server/peer-availability.js";
import { acceptOwnerTranscript, catchUpSharedTranscript, flushSharedTranscripts, resetSharedTranscriptPulls, setTranscriptStallTimeout, sharedTranscriptInventory, sharedTranscriptStatus } from "../src/server/shared-transcripts.js";
import { addProject, removeProject } from "../src/store.js";

const hash = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");

async function fixture(t: TestContext) {
  const local = await getClusterNode(), db = await clusterV2Database(), peer = randomUUID();
  const remote = new DatabaseSync(":memory:");
  t.after(() => remote.close());
  const invite = createTwinInvitation(db, local.id);
  const acceptance = prepareTwinAcceptance(remote, peer, invite, invite.body.inviter.fingerprint);
  applyTwinCertificate(remote, peer, confirmTwinAcceptance(db, local.id, acceptance, invite.secret));
  const project = await addProject("Transcript snapshot", path.join(os.homedir(), randomUUID()));
  const sessionId = randomUUID();
  await ensureConversationRecord(project.id, "pi", sessionId, peer);
  const destination = path.join(getHarness("pi").sync.transcriptRoot(), `${sessionId}.jsonl`);
  const at = new Date().toISOString();
  const content = JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: project.path, timestamp: at }) + "\n"
    + JSON.stringify({ type: "message", id: "first", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "Synthetic turn" }] } }) + "\n";
  return { db, local, peer, remote, relationshipId: invite.body.relationshipId, project, sessionId, destination, content };
}

test("transcript inventory hashes only the advertised bytes when the owner appends during hashing", async (t) => {
  const f = await fixture(t);
  await mkdir(path.dirname(f.destination), { recursive: true });
  await writeFile(f.destination, f.content);
  const original = fs.createReadStream;
  let appended = false;
  const mock = t.mock.method(fs, "createReadStream", (...args: Parameters<typeof original>) => {
    if (args[0] === f.destination && !appended) {
      appended = true;
      appendFileSync(f.destination, "appended while hashing\n");
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  const entries = await sharedTranscriptInventory(f.peer, f.project.id, { engine: "pi", sessionId: f.sessionId });
  assert.equal(appended, true, "the file grew after stat but before hashing");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].size, Buffer.byteLength(f.content));
  assert.equal(entries[0].hash, hash(f.content), "the advertised hash must describe exactly the advertised size");
});

for (const fail of [false, true]) {
  test(`deletion during held inventory cannot restore ${fail ? "failure" : "progress"}`, async (t) => {
    const f = await fixture(t);
    const app = express();
    let entered!: () => void, release!: () => void;
    const arrived = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    app.use((request, response, next) => {
      try { assert.equal(verifyClusterRequest(f.remote, f.peer, "GET", request.originalUrl, Buffer.alloc(0), request.header("authorization")), f.local.id); next(); }
      catch { response.sendStatus(401); }
    });
    app.get("/api/cluster/v2/transcripts", async (_request, response) => {
      entered(); await gate;
      if (fail) response.sendStatus(500);
      else response.json({ entries: [] });
    });
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => { release(); server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    recordPeerEndpoint(f.db, { kind: "twin", id: f.relationshipId }, { nodeId: f.peer, name: "Held peer", url: `http://127.0.0.1:${address.port}` });
    resetSharedTranscriptPulls();
    const running = flushSharedTranscripts();
    await arrived;
    await removeProject(f.project.id);
    release();
    await running;
    assert.equal(f.db.prepare("SELECT 1 FROM cluster_v2_transcript_errors WHERE project_id=?").get(f.project.id), undefined);
    assert.equal(f.db.prepare("SELECT 1 FROM cluster_v2_transcript_progress WHERE project_id=?").get(f.project.id), undefined);
    assert.equal(f.db.prepare("SELECT deleted FROM cluster_v2_resource_policy WHERE resource_id=?").get(f.project.id)?.deleted, 1);
  });
}

for (const empty of [false, true]) {
  test(`a growing ${empty ? "empty" : "nonempty"} transcript syncs the advertised snapshot, then catches up`, async (t) => {
    const f = await fixture(t);
    let advertised = empty ? "" : f.content;
    const appended = JSON.stringify({ type: "message", id: "second", parentId: "first", message: { role: "assistant", content: [{ type: "text", text: "Synthetic reply" }] } }) + "\n";
    const source = path.join(f.project.path, "source.jsonl");
    const sourceBytes = f.content + appended;
    await writeFile(source, sourceBytes);
    const app = express();
    const ranges: Array<string | undefined> = [];
    app.use((request, response, next) => {
      try {
        assert.equal(verifyClusterRequest(f.remote, f.peer, "GET", request.originalUrl, Buffer.alloc(0), request.header("authorization")), f.local.id);
        next();
      } catch { response.sendStatus(401); }
    });
    app.get("/api/cluster/v2/transcripts", (_request, response) => response.json({ entries: [{ engine: "pi", sessionId: f.sessionId, relativePath: path.basename(f.destination), size: Buffer.byteLength(advertised), hash: hash(advertised) }] }));
    app.get("/api/cluster/v2/transcripts/file", (request, response) => {
      ranges.push(request.header("range"));
      response.sendFile(source);
    });
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    recordPeerEndpoint(f.db, { kind: "twin", id: f.relationshipId }, { nodeId: f.peer, name: "Synthetic owner", url: `http://127.0.0.1:${address.port}` });

    await catchUpSharedTranscript(f.peer, "pi", f.sessionId);
    assert.equal(await readFile(f.destination, "utf8"), advertised, "growth after the inventory does not fail or copy unadvertised bytes");
    assert.deepEqual(ranges, empty ? [] : [`bytes=0-${Buffer.byteLength(advertised) - 1}`]);
    advertised = sourceBytes;
    await catchUpSharedTranscript(f.peer, "pi", f.sessionId);
    assert.equal(await readFile(f.destination, "utf8"), sourceBytes, "the next inventory brings in the appended turn");

    // A range is not permission to accept changed bytes: hash validation and local-history
    // protection must both survive the growth fix.
    await writeFile(source, sourceBytes.replace("Synthetic turn", "Corrupted turn"));
    await writeFile(f.destination, f.content);
    await assert.rejects(catchUpSharedTranscript(f.peer, "pi", f.sessionId), /Transcript changed during transfer/);
    assert.equal(await readFile(f.destination, "utf8"), f.content);
    await writeFile(source, sourceBytes);
    const localEdit = f.content.replace("Synthetic turn", "Local new turn");
    await writeFile(f.destination, localEdit);
    await assert.rejects(catchUpSharedTranscript(f.peer, "pi", f.sessionId), /Divergent transcript requires review/);
    assert.equal(await readFile(f.destination, "utf8"), localEdit, "divergent history is never overwritten");
    assert.deepEqual((await readdir(path.dirname(f.destination))).filter(name => name.startsWith(`${f.sessionId}.jsonl.`)), [], "failed transfers leave no temporary files");
  });
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** An owner that advertises `advertised()` for the fixture's conversation and serves its bytes through `file`. */
async function owner(t: TestContext, f: Fixture, advertised: () => string | undefined, file: express.RequestHandler): Promise<Server> {
  const app = express();
  app.use((request, response, next) => {
    try { assert.equal(verifyClusterRequest(f.remote, f.peer, "GET", request.originalUrl, Buffer.alloc(0), request.header("authorization")), f.local.id); next(); }
    catch { response.sendStatus(401); }
  });
  app.get("/api/cluster/v2/transcripts", (_request, response) => {
    const bytes = advertised();
    response.json({ entries: bytes === undefined ? [] : [{ engine: "pi", sessionId: f.sessionId, relativePath: path.basename(f.destination), size: Buffer.byteLength(bytes), hash: hash(bytes) }] });
  });
  app.get("/api/cluster/v2/transcripts/file", file);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  recordPeerEndpoint(f.db, { kind: "twin", id: f.relationshipId }, { nodeId: f.peer, name: "Synthetic owner", url: `http://127.0.0.1:${address.port}` });
  return server;
}

const partials = async (f: Fixture): Promise<string[]> => (await readdir(path.dirname(f.destination))).filter(name => name.startsWith(`${f.sessionId}.jsonl.`));
/** The requested range of `bytes`, answered the way sendFile answers it. */
function ranged(request: express.Request, response: express.Response, bytes: Buffer): Buffer {
  const [, from, to] = /^bytes=(\d+)-(\d+)$/.exec(request.header("range") ?? "") ?? [];
  const body = bytes.subarray(Number(from), Number(to) + 1);
  response.status(206).set({ "Content-Type": "application/octet-stream", "Content-Range": `bytes ${from}-${to}/${bytes.length}`, "Content-Length": String(body.length) });
  return body;
}

test("a transcript transfer that is cut off resumes from the bytes already received", async (t) => {
  const f = await fixture(t);
  const content = f.content + "x".repeat(200_000) + "\n", bytes = Buffer.from(content), cut = 70_000;
  const ranges: string[] = [];
  await owner(t, f, () => content, (request, response) => {
    ranges.push(request.header("range") ?? "");
    const body = ranged(request, response, bytes);
    if (ranges.length > 1) { response.end(body); return; }
    // The connection drops after part of the body arrived.
    response.write(body.subarray(0, cut), () => setTimeout(() => request.socket.destroy(), 100));
  });

  await assert.rejects(catchUpSharedTranscript(f.peer, "pi", f.sessionId));
  assert.deepEqual(await partials(f), [`${f.sessionId}.jsonl.${f.peer}.part`], "what arrived is kept for the next attempt");
  await catchUpSharedTranscript(f.peer, "pi", f.sessionId);
  assert.deepEqual(ranges, [`bytes=0-${bytes.length - 1}`, `bytes=${cut}-${bytes.length - 1}`], "the second attempt asks only for the missing bytes");
  assert.equal(await readFile(f.destination, "utf8"), content);
  assert.deepEqual(await partials(f), [], "a finished transfer leaves no partial file");
});

test("a kept partial transfer that no longer matches its owner's copy is dropped and fetched whole", async (t) => {
  const f = await fixture(t);
  const ranges: string[] = [];
  await owner(t, f, () => f.content, (request, response) => { ranges.push(request.header("range") ?? ""); response.end(ranged(request, response, Buffer.from(f.content))); });
  await mkdir(path.dirname(f.destination), { recursive: true });
  await writeFile(`${f.destination}.${f.peer}.part`, "not the owner's bytes");

  await assert.rejects(catchUpSharedTranscript(f.peer, "pi", f.sessionId), /Transcript changed during transfer/);
  assert.deepEqual(await partials(f), []);
  await catchUpSharedTranscript(f.peer, "pi", f.sessionId);
  assert.equal(ranges.at(-1), `bytes=0-${Buffer.byteLength(f.content) - 1}`);
  assert.equal(await readFile(f.destination, "utf8"), f.content);
});

test("a slow transcript transfer finishes while bytes keep arriving, and only a stalled one is given up", async (t) => {
  const f = await fixture(t);
  setTranscriptStallTimeout(400);
  t.after(() => setTranscriptStallTimeout(30_000));
  const content = f.content + "y".repeat(5_000) + "\n", bytes = Buffer.from(content);
  let stall = false;
  await owner(t, f, () => content, (request, response) => {
    const body = ranged(request, response, bytes), pieces = 6, size = Math.ceil(body.length / pieces);
    let sent = 0;
    // Six pieces 150 ms apart take longer in total than the stall limit allows between two of them.
    const timer = setInterval(() => {
      response.write(body.subarray(sent, sent + size)); sent += size;
      if (stall || sent >= body.length) { clearInterval(timer); if (!stall) response.end(); }
    }, 150);
    response.on("close", () => clearInterval(timer));
  });

  const started = Date.now();
  await catchUpSharedTranscript(f.peer, "pi", f.sessionId);
  assert.ok(Date.now() - started > 400, "the transfer outlasted the stall limit");
  assert.equal(await readFile(f.destination, "utf8"), content);

  stall = true;
  await writeFile(f.destination, f.content);
  f.db.prepare("DELETE FROM cluster_v2_transcript_receipts WHERE peer_id=?").run(f.peer);
  await assert.rejects(catchUpSharedTranscript(f.peer, "pi", f.sessionId), /Transcript transfer stalled/);
  assert.equal((await partials(f)).length, 1, "the bytes received before the stall are kept");
});

test("a conversation both machines continued is fetched once, kept for review, and settled by taking its owner's history", async (t) => {
  const f = await fixture(t);
  let theirs = f.content + JSON.stringify({ type: "message", id: "theirs", parentId: "first", message: { role: "user", content: [{ type: "text", text: "Owner turn" }] } }) + "\n";
  const mine = f.content + JSON.stringify({ type: "message", id: "mine", parentId: "first", message: { role: "user", content: [{ type: "text", text: "Local turn" }] } }) + "\n";
  let downloads = 0;
  await owner(t, f, () => theirs, (request, response) => { downloads++; response.end(ranged(request, response, Buffer.from(theirs))); });
  await mkdir(path.dirname(f.destination), { recursive: true });
  await writeFile(f.destination, mine);

  await assert.rejects(catchUpSharedTranscript(f.peer, "pi", f.sessionId), /Divergent transcript requires review/);
  await assert.rejects(catchUpSharedTranscript(f.peer, "pi", f.sessionId), /Divergent transcript requires review/);
  assert.equal(downloads, 1, "an unchanged conflict is not downloaded again on every pull");
  assert.equal(await readFile(f.destination, "utf8"), mine, "divergent history is never overwritten unreviewed");
  assert.deepEqual(await partials(f), []);
  const conflict = f.db.prepare("SELECT artifact FROM cluster_v2_transcript_conflicts WHERE peer_id=? AND session_id=?").get(f.peer, f.sessionId) as { artifact: string };
  assert.equal(await readFile(conflict.artifact, "utf8"), theirs, "the owner's version is kept for review");
  assert.equal(path.relative(getHarness("pi").sync.transcriptRoot(), conflict.artifact).startsWith(".."), true, "kept copies are not listed as conversations");
  assert.deepEqual(sharedTranscriptStatus(f.db, f.local.id, f.peer).conflicts?.map(({ projectId, engine, sessionId }) => ({ projectId, engine, sessionId })),
    [{ projectId: f.project.id, engine: "pi", sessionId: f.sessionId }], "the status names the conversation to settle");

  // Either side changing reopens the comparison; a stale review cannot replace newer local work.
  await appendFile(f.destination, JSON.stringify({ type: "custom" }) + "\n");
  await assert.rejects(acceptOwnerTranscript(f.peer, f.project.id, "pi", f.sessionId), /changed since it was compared/);
  await assert.rejects(catchUpSharedTranscript(f.peer, "pi", f.sessionId), /Divergent transcript requires review/);
  assert.equal(downloads, 2);
  const local = await readFile(f.destination, "utf8");

  f.db.prepare("INSERT OR REPLACE INTO cluster_v2_transcript_errors VALUES(?,?,?)").run(f.peer, f.project.id, "Divergent transcript requires review");
  const { saved } = await acceptOwnerTranscript(f.peer, f.project.id, "pi", f.sessionId);
  assert.equal(await readFile(f.destination, "utf8"), theirs, "the owner's history is installed");
  assert.equal(await readFile(saved, "utf8"), local, "this machine's version is saved first");
  assert.equal(f.db.prepare("SELECT 1 FROM cluster_v2_transcript_conflicts WHERE peer_id=?").get(f.peer), undefined);
  assert.equal(f.db.prepare("SELECT 1 FROM cluster_v2_transcript_errors WHERE peer_id=? AND project_id=?").get(f.peer, f.project.id), undefined, "the project stops reporting the settled conversation");
  await assert.rejects(readFile(conflict.artifact), /ENOENT/);
  await assert.rejects(acceptOwnerTranscript(f.peer, f.project.id, "pi", f.sessionId), /no longer needs review/);

  await catchUpSharedTranscript(f.peer, "pi", f.sessionId);
  assert.equal(downloads, 2, "the settled conversation is in sync");
  theirs += JSON.stringify({ type: "message", id: "later", parentId: "theirs", message: { role: "assistant", content: [{ type: "text", text: "Owner reply" }] } }) + "\n";
  await catchUpSharedTranscript(f.peer, "pi", f.sessionId);
  assert.equal(await readFile(f.destination, "utf8"), theirs, "later turns from the owner arrive as usual");
});

test("a conflict over a conversation its owner no longer offers is dropped", async (t) => {
  const f = await fixture(t);
  let theirs: string | undefined = f.content.replace("Synthetic turn", "Owner turn");
  await owner(t, f, () => theirs, (request, response) => response.end(ranged(request, response, Buffer.from(theirs!))));
  await mkdir(path.dirname(f.destination), { recursive: true });
  await writeFile(f.destination, f.content);
  await assert.rejects(catchUpSharedTranscript(f.peer, "pi", f.sessionId), /Divergent transcript requires review/);
  const conflict = f.db.prepare("SELECT artifact FROM cluster_v2_transcript_conflicts WHERE peer_id=?").get(f.peer) as { artifact: string };

  theirs = undefined;
  resetSharedTranscriptPulls(); resetPeerAvailability();
  await flushSharedTranscripts();
  assert.equal(f.db.prepare("SELECT 1 FROM cluster_v2_transcript_conflicts WHERE peer_id=?").get(f.peer), undefined);
  await assert.rejects(readFile(conflict.artifact), /ENOENT/);
  assert.equal(sharedTranscriptStatus(f.db, f.local.id, f.peer).conflicts, undefined);
  assert.equal(await readFile(f.destination, "utf8"), f.content, "this machine's copy is untouched");
});

test("a peer that stops answering is reported once, not as unreachable on every shared project", async (t) => {
  const f = await fixture(t);
  const second = await addProject("Transcript snapshot two", path.join(os.homedir(), randomUUID()));
  let down = true;
  const server = createServer((request, response) => { if (down) request.socket.destroy(); else response.setHeader("Content-Type", "application/json").end(JSON.stringify({ entries: [] })); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { resetPeerAvailability(); server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  recordPeerEndpoint(f.db, { kind: "twin", id: f.relationshipId }, { nodeId: f.peer, name: "Flaky peer", url: `http://127.0.0.1:${address.port}` });
  // A twin shares every project, so the one tried first may be any of them.
  const errors = (): Array<{ project_id: string; error: string }> => f.db.prepare("SELECT project_id,error FROM cluster_v2_transcript_errors WHERE peer_id=?").all(f.peer) as never;

  resetSharedTranscriptPulls(); resetPeerAvailability();
  await flushSharedTranscripts();
  const failed = errors();
  assert.equal(failed.length, 1, "only the project that was actually tried reports the failure");
  assert.doesNotMatch(failed[0].error, /Cluster peer is unreachable/);
  const skipped = [f.project.id, second.id].find(id => id !== failed[0].project_id)!;

  // The peer answers again: the project that was skipped is pulled at once, not an interval later.
  down = false; markPeerReachable(f.peer);
  await flushSharedTranscripts();
  assert.ok(f.db.prepare("SELECT 1 FROM cluster_v2_transcript_progress WHERE peer_id=? AND project_id=?").get(f.peer, skipped));
  assert.deepEqual(errors().map(row => row.project_id), [failed[0].project_id], "a project waits for its own next pull to clear its report");
});
