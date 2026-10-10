import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs, { appendFileSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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
import { catchUpSharedTranscript, flushSharedTranscripts, resetSharedTranscriptPulls, sharedTranscriptInventory } from "../src/server/shared-transcripts.js";
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
