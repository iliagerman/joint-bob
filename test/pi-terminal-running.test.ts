import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import WebSocket from "ws";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("Pi terminal turns stay out of pending reviews until settled or their heartbeat expires", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-pi-terminal-"));
  let server;
  let socket: WebSocket | undefined;
  let db: DatabaseSync | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    server = await startDevNode(environment, node);
    const login = await signIn(environment, node);
    const project = node.projects[0];
    type Row = { id: string; path: string; harnessId: string; running: boolean; reviewState: string };
    const sessions = () => api<{ sessions: Row[] }>(node, login, "GET", `/projects/${project.id}/sessions`);
    const target = (await sessions()).body.sessions.find((row) => row.harnessId === "pi")!;
    db = new DatabaseSync(path.join(node.dataDir, "node.db"));
    db.exec(`CREATE TABLE IF NOT EXISTS pi_runtime_sessions (
      session_id TEXT NOT NULL, run_id TEXT NOT NULL, transcript_path TEXT NOT NULL,
      expires_at TEXT NOT NULL, PRIMARY KEY (session_id, run_id)
    )`);
    db.prepare("UPDATE conversation_review_states SET reviewed_at = '2000-01-01T00:00:00.000Z' WHERE session_path = ?").run(target.path);
    const pending = async () => {
      const result = await api<{ projects: Array<{ sessions: Array<{ id: string }> }> }>(node, login, "GET", "/reviews/pending");
      assert.equal(result.status, 200);
      return result.body.projects.flatMap((group) => group.sessions).some((row) => row.id === target.id);
    };
    assert.equal(await pending(), true, "precondition: terminal conversation owes a review");
    const watchUrl = new URL("/ws", node.url.replace(/^http/, "ws"));
    watchUrl.searchParams.set("projectId", project.id);
    watchUrl.searchParams.set("sessionPath", "watch");
    socket = new WebSocket(watchUrl, { headers: { Cookie: login.cookie, Origin: node.url } });
    let changed = false;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("watch socket not ready")), 10_000);
      socket!.on("message", (raw) => {
        const event = JSON.parse(raw.toString());
        if (event.type === "sessionsChanged") changed = true;
        if (event.type === "watchReady") { clearTimeout(timeout); resolve(); }
      });
      socket!.once("error", reject);
    });
    const heartbeat = (expiresAt: string) => db!.prepare("INSERT OR REPLACE INTO pi_runtime_sessions VALUES (?, ?, ?, ?)")
      .run(target.id, "terminal-run", target.path, expiresAt);
    heartbeat(new Date(Date.now() + 60_000).toISOString());
    const active = (await sessions()).body.sessions.find((row) => row.id === target.id)!;
    assert.equal(active.running, true, "terminal running state must reach the session list");
    assert.equal(active.reviewState, "running");
    assert.equal(await pending(), false, "a running terminal must not request review");
    const deadline = Date.now() + 8_000;
    while (!changed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(changed, true, "terminal activity must refresh already-open browser tabs without a transcript write");
    const running = await api<{ projects: Array<{ sessions: Array<{ id: string }> }> }>(node, login, "GET", "/running");
    assert.ok(running.body.projects.flatMap((group) => group.sessions).some((row) => row.id === target.id));
    db.prepare("DELETE FROM pi_runtime_sessions WHERE session_id = ?").run(target.id);
    assert.equal(await pending(), true, "settled turns return to review");
    heartbeat(new Date(Date.now() - 1_000).toISOString());
    assert.equal((await sessions()).body.sessions.find((row) => row.id === target.id)!.running, false);
    assert.equal(await pending(), true, "crashed terminals do not remain running forever");
  } finally {
    socket?.close();
    db?.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
