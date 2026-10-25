import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { WorkerBridge } from "../src/file-sync/bridge.js";
import { compileRules, effectiveRules } from "../src/file-sync/ignore.js";
import type { FileSyncStatusAnswer } from "../src/file-sync/index.js";
import type { CoreEvent, ShareStatus } from "../src/file-sync/protocol.js";
import { EMPTY_RULE_SETTINGS } from "../src/file-sync/types.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode, type SignedIn } from "./dev-nodes.js";

/* P1 end to end: a real node runs the file sync worker in its own thread, indexes a shared project
   in shadow mode, follows edits through the watcher, and stops with the node or the switch. */

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** Synced files under root as an independent walk sees them, with the share's own rules. */
function syncedFiles(root: string): string[] {
  const matcher = compileRules(effectiveRules("project"));
  const found: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const key = relative ? `${relative}/${entry.name}` : entry.name;
      if (matcher.classify(key, entry.isDirectory()) !== null) continue;
      if (entry.isDirectory()) walk(key);
      else if (entry.isFile()) found.push(key);
    }
  };
  walk("");
  return found.sort();
}

/** Every path under root, ignored ones included. */
function treeListing(root: string): string[] {
  return (readdirSync(root, { recursive: true }) as string[]).map((entry) => entry.split(path.sep).join("/")).sort();
}

function status(node: SeededNode, session: SignedIn): Promise<FileSyncStatusAnswer> {
  return api<FileSyncStatusAnswer>(node, session, "GET", "/file-sync/status").then((answer) => {
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    return answer.body;
  });
}

function projectShare(answer: FileSyncStatusAnswer, projectId: string): ShareStatus | undefined {
  return answer.shares.find((share) => share.projectId === projectId && share.kind === "project");
}

async function stopTimed(child: ChildProcess): Promise<{ ms: number; code: number | null; signal: NodeJS.Signals | null }> {
  const started = Date.now();
  await stopDevNode(child);
  return { ms: Date.now() - started, code: child.exitCode, signal: child.signalCode };
}

test("turning file sync on, off and on again while it is starting leaves the worker running", { timeout: 60_000 }, async (t) => {
  const saved = process.env.JOINT_BOB_FILE_SYNC;
  delete process.env.JOINT_BOB_FILE_SYNC;
  // This process's data directory is the test runner's temporary one.
  const { applyFileSyncConfig, fileSyncStatus, startFileSync, stopFileSync } = await import("../src/file-sync/index.js");
  t.after(async () => {
    await stopFileSync();
    if (saved === undefined) delete process.env.JOINT_BOB_FILE_SYNC;
    else process.env.JOINT_BOB_FILE_SYNC = saved;
  });
  // Off at startup: this only records that startup reached cluster work.
  await startFileSync();
  assert.equal((await fileSyncStatus()).worker, "off");
  // A double click, or two admin tabs: the second "on" comes while the first launch is still loading.
  await Promise.all([applyFileSyncConfig({ enabled: true }), applyFileSyncConfig({ enabled: false }), applyFileSyncConfig({ enabled: true })]);
  const settled = await until(fileSyncStatus, (answer) => answer.worker === "running", 30_000);
  assert.deepEqual([settled.enabled, settled.worker], [true, "running"]);
});

test("the main thread's bridge drives the real worker thread: configure, scan, status, error codes and stop", { timeout: 60_000 }, async (t) => {
  const dataDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "file-sync-bridge-real-")));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const root = path.join(dataDir, "project");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(path.join(root, "notes.md"), "notes\n");
  await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  const events: CoreEvent[] = [];
  const metrics: Array<{ operation: string; fields: Record<string, string | number | boolean> }> = [];
  const bridge = new WorkerBridge({
    nodeId: "node-a", dataDir: path.join(dataDir, "data"), workerData: { watch: false },
    onEvent: (event) => events.push(event), metrics: (operation, _durationMs, fields) => metrics.push({ operation, fields }),
  });
  t.after(() => bridge.stop());
  bridge.start();
  const share = { key: "project:p1", projectId: "p1", kind: "project" as const, root, phase: "syncthing" as const, rules: EMPTY_RULE_SETTINGS, peers: ["node-b"] };
  assert.deepEqual(await bridge.call("configure", { enabled: true, hostId: "host-a", shares: [share], peers: [], records: { engines: [], settings: [] } }), { origins: [] });
  const scanned = await bridge.call("scan", { share: "project:p1", scope: "full", reason: "test" });
  assert.deepEqual([scanned.share, scanned.newGeneration, scanned.tombstones, scanned.error], ["project:p1", true, 0, undefined]);
  const [status] = await bridge.call("status", {});
  assert.deepEqual([status.share, status.state, status.liveFiles, status.maxSeq], ["project:p1", "idle", 2, 3], JSON.stringify(status));
  const reported = events.filter((event): event is Extract<CoreEvent, { event: "shareState" }> => event.event === "shareState").at(-1);
  assert.equal(reported?.status.liveFiles, 2, "shareState events reach the main thread");
  assert.ok(events.some((event) => event.event === "ready"));
  const scanMetric = metrics.find((metric) => metric.operation === "fileSync.scan");
  // Two files of 20 and 6 bytes hashed, three rows written (src/ too).
  assert.deepEqual([scanMetric?.fields.scope, scanMetric?.fields.changed, scanMetric?.fields.hashedBytes, scanMetric?.fields.thread], ["full", 3, 26, "worker"], JSON.stringify(metrics));

  // The worker has its network layer; with no peers there is nobody to ask. Later phases' ops are not there yet.
  assert.deepEqual(await bridge.call("announce", { slept: false }), {});
  await assert.rejects(bridge.call("prioritize", { share: "project:p1", untilMs: 1000 }), (error: Error & { code?: string }) => error.code === "unavailable", "later phases' ops are not there yet");
  await assert.rejects(bridge.call("scan", { share: "project:p1", scope: "everything" as "full", reason: "test" }), (error: Error & { code?: string }) => error.code === "invalid" && /scope/.test(error.message));
  await assert.rejects(bridge.call("flush", { share: "project:gone" }), /share not found/);

  assert.ok(existsSync(path.join(dataDir, "data", "file-sync.db-wal")), "the worker holds file-sync.db open");
  // With a long budget, a worker that did not close file-sync.db and end by itself would be terminated only after ~20 s.
  const stopping = Date.now();
  await bridge.stop(20_000);
  const stopMs = Date.now() - stopping;
  assert.equal(bridge.state, "stopped");
  assert.ok(stopMs < 5_000, `the worker took ${stopMs} ms to end after its stop op`);
  assert.equal(existsSync(path.join(dataDir, "data", "file-sync.db-wal")), false, "the worker closed file-sync.db before it ended");
});

test("a node with file sync on indexes a shared project in shadow mode, follows edits, and stops cleanly", { timeout: 240_000 }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "file-sync-node-")));
  const children: ChildProcess[] = [];
  try {
    const a = await seedDevEnvironment(path.join(root, "a"), 1), b = await seedDevEnvironment(path.join(root, "b"), 1);
    const left = a.nodes[0], right = b.nodes[0];
    const [leftChild, rightChild] = await Promise.all([startDevNode(a, left, { JOINT_BOB_FILE_SYNC: "1" }), startDevNode(b, right)]);
    children.push(leftChild, rightChild);
    // Every engine warning starts with "File sync" or "File scan"; a healthy run prints none.
    const engineLines: string[] = [];
    for (const child of children) for (const stream of [child.stdout!, child.stderr!]) {
      stream.on("data", (chunk: Buffer) => engineLines.push(...String(chunk).split("\n").filter((line) => /File (sync|scan)/.test(line))));
    }
    const sa = await signIn(a, left), sb = await signIn(b, right);
    const invitation = await api<{ link: string }>(left, sa, "POST", "/twins/invitations", { confirmOwnedData: true });
    assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
    const accepted = await api(right, sb, "POST", "/twins/accept", { link: invitation.body.link, confirmOwnedData: true });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));

    const directory = path.join(root, "project");
    await mkdir(path.join(directory, "src"), { recursive: true });
    await mkdir(path.join(directory, "node_modules", "pkg"), { recursive: true });
    await mkdir(path.join(directory, ".git"), { recursive: true });
    await writeFile(path.join(directory, "src", "index.ts"), "export const answer = 41;\n");
    await writeFile(path.join(directory, "README.md"), "# Shadow\n");
    await writeFile(path.join(directory, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    await writeFile(path.join(directory, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(path.join(directory, ".env"), "TOKEN=local-only\n");
    const created = await api<{ project: { id: string } }>(left, sa, "POST", "/projects", { name: "Shadow indexed", type: "personal", path: directory, synced: true });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const projectId = created.body.project.id;
    const treeBefore = treeListing(directory);

    // Saving the shadow list derives the shares at once: a shared project outside it is not indexed.
    const before = await api<FileSyncStatusAnswer>(left, sa, "PUT", "/file-sync/config", { shadowProjects: [] });
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.deepEqual([before.body.enabled, before.body.config.enabledBy, before.body.worker], [true, "environment", "running"]);
    assert.equal(projectShare(before.body, projectId), undefined, "a project outside the shadow list is not indexed");
    const configured = await api<FileSyncStatusAnswer>(left, sa, "PUT", "/file-sync/config", { shadowProjects: [projectId] });
    assert.equal(configured.status, 200, JSON.stringify(configured.body));

    const expected = syncedFiles(directory);
    assert.ok(expected.includes("src/index.ts") && expected.includes("README.md"), `synced files: ${expected.join(", ")}`);
    assert.ok(!expected.some((file) => file.startsWith("node_modules/") || file.startsWith(".git/") || file === ".env"), `ignored files stay out: ${expected.join(", ")}`);
    const indexed = await until(() => status(left, sa), (answer) => {
      const share = projectShare(answer, projectId);
      return share?.state === "idle" && share.liveFiles === expected.length;
    }, 60_000);
    const share = projectShare(indexed, projectId);
    assert.equal(indexed.worker, "running");
    assert.deepEqual(indexed.shares.filter((candidate) => candidate.projectId === projectId).map((candidate) => candidate.kind).sort(), ["project", "tickets", "worktrees"]);
    assert.equal(share?.state, "idle", JSON.stringify(share));
    assert.equal(share?.phase, "syncthing");
    assert.equal(share?.liveFiles, expected.length, `indexed ${share?.liveFiles} of ${expected.length}: ${expected.join(", ")}`);
    assert.deepEqual(share?.peers.map((peer) => peer.peer), [right.nodeId]);
    assert.ok(existsSync(path.join(left.dataDir, "file-sync.db-wal")), "the worker holds file-sync.db open");

    // An ignored write is dropped by the watcher; the edit is one new version.
    const seqBefore = share!.maxSeq;
    await writeFile(path.join(directory, "node_modules", "pkg", "extra.js"), "module.exports = 2;\n");
    const editedAt = Date.now();
    await writeFile(path.join(directory, "src", "index.ts"), "export const answer = 42;\n");
    const edited = await until(() => status(left, sa), (answer) => (projectShare(answer, projectId)?.maxSeq ?? 0) > seqBefore, 15_000);
    const seenMs = Date.now() - editedAt;
    assert.ok((projectShare(edited, projectId)?.maxSeq ?? 0) > seqBefore, `the edit never reached the index: ${JSON.stringify(projectShare(edited, projectId))}`);
    assert.ok(seenMs < 10_000, `the edit took ${seenMs} ms to reach the index`);
    t.diagnostic(`edit indexed after ${seenMs} ms`);
    const settled = await until(() => status(left, sa), (answer) => projectShare(answer, projectId)?.state === "idle", 15_000);
    assert.equal(projectShare(settled, projectId)?.maxSeq, seqBefore + 1, "one edit is one new version; the ignored file is none");
    assert.equal(projectShare(settled, projectId)?.liveFiles, expected.length);
    // Shadow mode writes nothing into the tree (no .git/info/exclude, no temp files).
    assert.deepEqual(treeListing(directory), [...treeBefore, "node_modules/pkg/extra.js"].sort());

    // Opening the project flushes its shares through the worker (any failure would be logged).
    const socket = new WebSocket(`${left.url.replace(/^http/, "ws")}/ws?projectId=${projectId}&sessionPath=watch`, { origin: left.url, headers: { Cookie: sa.cookie } });
    const ready = await new Promise<unknown>((resolve, reject) => {
      socket.once("message", (raw) => resolve(JSON.parse(raw.toString())));
      socket.once("error", reject);
    });
    assert.deepEqual(ready, { type: "watchReady" });
    socket.close();

    // The environment's switch wins, so the Settings switch cannot turn it off here.
    const refused = await api<{ error: string }>(left, sa, "PUT", "/file-sync/config", { enabled: false });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.match(refused.body.error, /JOINT_BOB_FILE_SYNC/);

    // Node B runs without JOINT_BOB_FILE_SYNC: file sync stays off and leaves no file-sync.db.
    assert.equal(existsSync(path.join(right.dataDir, "file-sync.db")), false, "the engine started without being enabled");
    const offStatus = await status(right, sb);
    assert.deepEqual([offStatus.enabled, offStatus.worker, offStatus.config.enabledBy], [false, "off", "default"]);
    // Startup has reached cluster work by now, so enabling starts the worker at once.
    const enabled = await api<FileSyncStatusAnswer>(right, sb, "PUT", "/file-sync/config", { enabled: true });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
    assert.notEqual(enabled.body.worker, "off");
    const running = await until(() => status(right, sb), (answer) => answer.worker === "running" && existsSync(path.join(right.dataDir, "file-sync.db")), 30_000);
    assert.equal(running.worker, "running");
    assert.ok(existsSync(path.join(right.dataDir, "file-sync.db")));
    const disabled = await api<FileSyncStatusAnswer>(right, sb, "PUT", "/file-sync/config", { enabled: false });
    assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
    assert.deepEqual([disabled.body.enabled, disabled.body.worker, disabled.body.shares], [false, "off", []]);
    // The worker thread is gone: SQLite removes the write-ahead log when its connection closes.
    assert.equal(existsSync(path.join(right.dataDir, "file-sync.db-wal")), false, "the worker still holds file-sync.db");

    for (const child of children.splice(0)) {
      const stopped = await stopTimed(child);
      assert.ok(stopped.ms < 10_000 && stopped.code === 0, `node stopped in ${stopped.ms} ms with ${stopped.code ?? stopped.signal}`);
      t.diagnostic(`node stopped in ${stopped.ms} ms`);
    }
    assert.equal(existsSync(path.join(left.dataDir, "file-sync.db-wal")), false, "the worker outlived the node's shutdown");
    assert.deepEqual(engineLines, [], "the engine logged problems");
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
