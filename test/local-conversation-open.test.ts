import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import WebSocket from "ws";
import { ensureConversationRecordSchema } from "../src/conversation-records.js";
import { claudeProjectDir } from "../src/session-paths.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("recorded local single-segment open reaches ready without reading unrelated transcripts", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-local-open-"));
  let server: ChildProcess | undefined;
  let socket: WebSocket | undefined;
  let db: DatabaseSync | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const project = node.projects[0];
    const sessionId = randomUUID();
    const directory = claudeProjectDir(project.path, path.join(environment.home, ".claude", "projects"));
    const transcript = path.join(directory, `${sessionId}.jsonl`);
    const text = "Only this local conversation should be read on open.";
    const contents = JSON.stringify({ type: "user", uuid: randomUUID(), sessionId, cwd: project.path,
      timestamp: new Date().toISOString(), message: { role: "user", content: text } }) + "\n";
    await writeFile(transcript, contents);
    server = await startDevNode(environment, node);
    const credentials = await signIn(environment, node);

    db = new DatabaseSync(path.join(node.dataDir, "node.db"));
    db.exec("PRAGMA busy_timeout = 5000");
    ensureConversationRecordSchema(db);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO conversation_records
      (project_id, engine, session_id, created_at, updated_at, origin_node_id, conversation_id, segment_index)
      VALUES (?, 'claude', ?, ?, ?, ?, ?, 0)`).run(project.id, sessionId, now, now, node.nodeId, sessionId);
    assert.deepEqual(db.prepare(`SELECT session_id, segment_index FROM conversation_records
      WHERE project_id = ? AND conversation_id = ?`).all(project.id, sessionId).map((row) => ({ ...row })),
    [{ session_id: sessionId, segment_index: 0 }], "the recorded conversation must have exactly one explicit segment");

    // A directory with a transcript suffix is enumerated by the real catalog,
    // but readFile fails with EISDIR even when tests run with elevated privileges.
    // Install after startup so only the open/catalog behavior is under test.
    const poison = path.join(directory, `${randomUUID()}.jsonl`);
    await mkdir(poison);
    await assert.rejects(readFile(poison, "utf8"), { code: "EISDIR" });
    const url = new URL("/ws", node.url.replace(/^http/, "ws"));
    url.searchParams.set("projectId", project.id);
    url.searchParams.set("sessionPath", `claude:${transcript}`);
    url.searchParams.set("sessionId", sessionId); // Required for the direct-open path.
    socket = new WebSocket(url, { origin: node.url, headers: { Cookie: credentials.cookie } });
    const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error("Local single-segment open did not receive ready")), 10_000);
      const finish = (error?: Error, event?: Record<string, unknown>): void => {
        clearTimeout(timeout);
        socket!.off("message", onMessage);
        socket!.off("close", onClose);
        socket!.off("error", onError);
        if (error) reject(error); else resolve(event!);
      };
      const onMessage = (raw: WebSocket.RawData): void => {
        const event = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (event.type === "ready") finish(undefined, event);
        else if (event.type === "error") finish(new Error(`Local open failed before ready: ${JSON.stringify(event)}`));
      };
      const onClose = (code: number, reason: Buffer): void => finish(new Error(
        `Local single-segment open must reach ready without reading unrelated transcripts; closed ${code}: ${reason}`));
      const onError = (error: Error): void => finish(error);
      socket!.on("message", onMessage);
      socket!.once("close", onClose);
      socket!.once("error", onError);
    });
    assert.equal(ready.sessionId, sessionId);
    assert.equal(ready.conversationId, sessionId);
    assert.equal(ready.executionNodeId, node.nodeId);
    assert.equal(ready.readOnly, false);
    assert.equal(ready.ownership, null, "local open must not acquire a foreign owner");
    assert.ok((ready.messages as Array<{ role: string; text: string }>).some((message) => message.role === "user" && message.text === text),
      "ready must contain the requested conversation's own message");
    assert.deepEqual({ ...db.prepare(`SELECT owner_node_id, epoch, status FROM conversation_ownership
      WHERE engine = 'claude' AND session_id = ?`).get(sessionId) },
    { owner_node_id: node.nodeId, epoch: 1, status: "owned" }, "opening must safely claim local ownership");
    assert.equal(await readFile(transcript, "utf8"), contents, "opening must not modify the transcript");

    // Positive control: this fixture really breaks a full project catalog.
    const catalog = await api<{ error: string }>(node, credentials, "GET", `/projects/${project.id}/sessions`);
    assert.equal(catalog.status, 500, JSON.stringify(catalog.body));
    assert.match(catalog.body.error, /EISDIR/);
  } finally {
    socket?.terminate();
    db?.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
