import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { FileSyncStatusAnswer } from "../src/file-sync/index.js";
import type { PeerShareStatus, ShareStatus } from "../src/file-sync/protocol.js";
import { api, freePort, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode, type SignedIn } from "./dev-nodes.js";

/* P2 end to end on real nodes, without Syncthing: two separately seeded one-node environments run
   the engine in shadow mode for a project shared between them. The test plays Syncthing by writing
   the same files on both sides. The engines must agree when the trees agree, find exactly the file
   that differs once it outlives the settle window, write nothing into either tree, talk over the
   direct listener when it can bind and through main's routes when it cannot, and stay quiet when
   nothing changes. */

const SETTLE_MS = 1_500;
const IDLE_MS = 12_000;

type Route = PeerShareStatus["route"];
type Listing = Map<string, string>;

interface Node { label: string; node: SeededNode; session: SignedIn; root: string }

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** Every path under root, ignored ones included, with what any write would change (directories' mtimes too). */
function listing(root: string): Listing {
  const found: Listing = new Map();
  const walk = (relative: string): void => {
    for (const name of readdirSync(path.join(root, relative)).sort()) {
      const key = relative ? `${relative}/${name}` : name;
      const st = lstatSync(path.join(root, key));
      found.set(key, `${st.isDirectory() ? "dir" : st.isSymbolicLink() ? "link" : "file"} ${st.size} ${st.mtimeMs} ${(st.mode & 0o777).toString(8)} ${st.ino}`);
      if (st.isDirectory()) walk(key);
    }
  };
  found.set("", `dir ${lstatSync(root).mtimeMs}`);
  walk("");
  return found;
}

function entryOf(root: string, relative: string): string {
  const st = lstatSync(path.join(root, relative));
  return `file ${st.size} ${st.mtimeMs} ${(st.mode & 0o777).toString(8)} ${st.ino}`;
}

async function writeTree(root: string): Promise<void> {
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await mkdir(path.join(root, ".git"), { recursive: true });
  await writeFile(path.join(root, "src", "index.ts"), "export const answer = 41;\n");
  await writeFile(path.join(root, "src", "util.ts"), "export const util = true;\n");
  await writeFile(path.join(root, "README.md"), "# Shadow nodes\n");
  await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  await writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
}

async function status(side: Node): Promise<FileSyncStatusAnswer> {
  const answer = await api<FileSyncStatusAnswer>(side.node, side.session, "GET", "/file-sync/status");
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body;
}

function projectShare(answer: FileSyncStatusAnswer, projectId: string): ShareStatus | undefined {
  return answer.shares.find((share) => share.projectId === projectId && share.kind === "project");
}

function peerOf(answer: FileSyncStatusAnswer, projectId: string, peer: string): PeerShareStatus | undefined {
  return projectShare(answer, projectId)?.peers.find((candidate) => candidate.peer === peer);
}

function requestsMade(answer: FileSyncStatusAnswer): number {
  assert.ok(answer.requests, `the status carries request counts: ${JSON.stringify(answer)}`);
  const { sent } = answer.requests;
  return sent.direct + sent.relay + sent.failed;
}

/** Both sides compare with each other, are caught up, and agree on the number of settled differences. */
async function agreed(sides: [Node, Node], projectId: string, differences: number, timeoutMs: number): Promise<FileSyncStatusAnswer[]> {
  const read = () => Promise.all(sides.map(status));
  return until(read, (answers) => answers.every((answer, index) => {
    const share = projectShare(answer, projectId);
    const peer = peerOf(answer, projectId, sides[1 - index].node.nodeId);
    return share?.state === "idle" && peer?.caughtUp === true && peer.rulesMatch && peer.differences === differences
      && (differences > 0 ? peer.cleanSince === null : peer.cleanSince !== null);
  }), timeoutMs);
}

async function runPair(t: TestContext, mode: "direct" | "relay"): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), `file-sync-shadow-${mode}-`)));
  const children: ChildProcess[] = [];
  const engineLines: string[] = [];
  try {
    const envA = await seedDevEnvironment(path.join(root, "a"), 1), envB = await seedDevEnvironment(path.join(root, "b"), 1);
    const [portA, portB] = await Promise.all([freePort(), freePort()]);
    // No Tailscale address on a dev machine: the listener binds loopback instead, or nothing at all.
    const engine = (port: number) => ({
      JOINT_BOB_FILE_SYNC: "1", JOINT_BOB_FILE_SYNC_SETTLE_MS: String(SETTLE_MS), JOINT_BOB_FILE_SYNC_PORT: String(port),
      JOINT_BOB_FILE_SYNC_LISTEN: mode === "direct" ? "127.0.0.1" : "none",
    });
    const [childA, childB] = await Promise.all([startDevNode(envA, envA.nodes[0], engine(portA)), startDevNode(envB, envB.nodes[0], engine(portB))]);
    children.push(childA, childB);
    for (const [label, child] of [["A", childA], ["B", childB]] as const) for (const stream of [child.stdout!, child.stderr!]) {
      stream.on("data", (chunk: Buffer) => engineLines.push(...String(chunk).split("\n").filter((line) => /File (sync|scan)/.test(line)).map((line) => `${label}: ${line}`)));
    }
    const a: Node = { label: "A", node: envA.nodes[0], session: await signIn(envA, envA.nodes[0]), root: path.join(root, "project") };
    const b: Node = { label: "B", node: envB.nodes[0], session: await signIn(envB, envB.nodes[0]), root: "" };
    const invitation = await api<{ link: string }>(a.node, a.session, "POST", "/twins/invitations", { confirmOwnedData: true });
    assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
    const accepted = await api(b.node, b.session, "POST", "/twins/accept", { link: invitation.body.link, confirmOwnedData: true });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));

    await writeTree(a.root);
    const created = await api<{ project: { id: string } }>(a.node, a.session, "POST", "/projects", { name: `Shadow ${mode}`, type: "personal", path: a.root, synced: true });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const projectId = created.body.project.id;
    const listed = await until(() => api<{ projects: Array<{ id: string; path: string }> }>(b.node, b.session, "GET", "/projects?syncStatus=false"),
      (answer) => answer.body.projects?.some((project) => project.id === projectId) ?? false, 30_000);
    const replica = listed.body.projects?.find((project) => project.id === projectId);
    assert.ok(replica?.path, `B lists the project with its own folder: ${JSON.stringify(listed.body)}`);
    b.root = replica.path;
    assert.notEqual(b.root, a.root);
    // Syncthing's part: the same files in B's folder.
    await writeTree(b.root);
    const before = [listing(a.root), listing(b.root)];

    // The test-only phase route exists only with JOINT_BOB_FILE_SYNC_TEST_PHASES=1 (file-sync-builtin-nodes.test.ts).
    const testPhase = await api(a.node, a.session, "POST", "/file-sync/test-phase", { projectId, phase: "builtin" });
    assert.equal(testPhase.status, 404, `no test-phase route on a node without the test switch: ${JSON.stringify(testPhase.body)}`);
    for (const side of [a, b]) {
      const configured = await api<FileSyncStatusAnswer>(side.node, side.session, "PUT", "/file-sync/config", { shadowProjects: [projectId] });
      assert.equal(configured.status, 200, JSON.stringify(configured.body));
      assert.equal(configured.body.worker, "running");
      if (mode === "direct") assert.deepEqual(configured.body.origins, [`http://127.0.0.1:${side === a ? portA : portB}`], "the listener bound the loopback address");
      else assert.deepEqual(configured.body.origins, [], "no listener");
    }

    // Identical trees: each side holds the other's whole index and finds nothing different.
    const clean = await agreed([a, b], projectId, 0, 60_000);
    for (const [index, answer] of clean.entries()) {
      const share = projectShare(answer, projectId);
      const peer = peerOf(answer, projectId, [b, a][index].node.nodeId);
      assert.deepEqual([share?.state, peer?.caughtUp, peer?.rulesMatch, peer?.differences], ["idle", true, true, 0], `${[a, b][index].label}: ${JSON.stringify(share)}`);
      assert.notEqual(peer?.cleanSince, null);
    }
    assert.equal(projectShare(clean[0], projectId)?.digest, projectShare(clean[1], projectId)?.digest, "both index the same content");

    // A file changed on A only: one difference on both sides once it outlives the settle window.
    const changedAt = Date.now();
    await writeFile(path.join(a.root, "src", "index.ts"), "export const answer = 42;\n");
    before[0].set("src/index.ts", entryOf(a.root, "src/index.ts"));
    const differing = await agreed([a, b], projectId, 1, 30_000);
    const foundMs = Date.now() - changedAt;
    for (const [index, answer] of differing.entries()) {
      const peer = peerOf(answer, projectId, [b, a][index].node.nodeId);
      assert.deepEqual([peer?.caughtUp, peer?.differences, peer?.cleanSince], [true, 1, null], `${[a, b][index].label} after the change on A: ${JSON.stringify(projectShare(answer, projectId))}`);
    }
    assert.ok(foundMs >= SETTLE_MS, `a difference counted after ${foundMs} ms, inside the ${SETTLE_MS} ms settle window`);
    t.diagnostic(`${mode}: the difference counted on both sides after ${foundMs} ms`);
    const shareKey = projectShare(differing[0], projectId)!.share;
    for (const [side, other] of [[a, b], [b, a]] as const) {
      const page = await api<{ total: number; items: Array<{ path: string; kind: string }> }>(side.node, side.session, "GET", `/file-sync/differences?share=${encodeURIComponent(shareKey)}&peer=${other.node.nodeId}`);
      assert.equal(page.status, 200, JSON.stringify(page.body));
      assert.deepEqual(page.body.items.map((item) => [item.path, item.kind]), [["src/index.ts", "content"]], `${side.label} names the file`);
    }

    // Syncthing copies it: nothing differs any more.
    await writeFile(path.join(b.root, "src", "index.ts"), "export const answer = 42;\n");
    before[1].set("src/index.ts", entryOf(b.root, "src/index.ts"));
    const again = await agreed([a, b], projectId, 0, 30_000);
    assert.equal(projectShare(again[0], projectId)?.digest, projectShare(again[1], projectId)?.digest, "the same content again, merged into one version");

    // Requests took the expected path both ways.
    for (const [index, answer] of again.entries()) {
      const other = [b, a][index].node.nodeId;
      const route: Route | undefined = peerOf(answer, projectId, other)?.route;
      assert.equal(route, mode, `${[a, b][index].label} reached its peer ${mode === "direct" ? "over the direct listener" : "through the main server"}: ${JSON.stringify(answer.peers)}`);
      assert.equal(answer.peers.find((peer) => peer.nodeId === other)?.route, mode);
      const { requests } = answer;
      assert.ok(requests, "request counts are reported");
      if (mode === "direct") {
        assert.ok(requests.sent.direct > 0 && requests.served.direct > 0, `direct traffic both ways: ${JSON.stringify(requests)}`);
      } else {
        assert.deepEqual([requests.sent.direct, requests.served.direct], [0, 0], `nothing direct: ${JSON.stringify(requests)}`);
        assert.ok(requests.sent.relay > 0 && requests.served.relay > 0, `relayed traffic both ways: ${JSON.stringify(requests)}`);
      }
    }

    // Idle: once the last notices and pulls are done, nothing more goes out.
    let quiet = await Promise.all([a, b].map(status));
    const settleDeadline = Date.now() + 20_000;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const next = await Promise.all([a, b].map(status));
      const same = next.every((answer, index) => requestsMade(answer) === requestsMade(quiet[index]));
      quiet = next;
      if (same || Date.now() > settleDeadline) break;
    }
    const idleStart = quiet.map(requestsMade);
    await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
    const idleEnd = (await Promise.all([a, b].map(status))).map(requestsMade);
    const idleRequests = idleEnd[0] - idleStart[0] + idleEnd[1] - idleStart[1];
    t.diagnostic(`${mode}: ${idleRequests} /files/* requests in ${IDLE_MS / 1000} idle seconds`);
    assert.ok(idleRequests <= 2, `idle nodes made ${idleRequests} /files/* requests in ${IDLE_MS / 1000} s (A ${idleEnd[0] - idleStart[0]}, B ${idleEnd[1] - idleStart[1]})`);

    // Shadow mode wrote nothing into either tree: every path, size, mtime, mode and inode is ours.
    assert.deepEqual([...listing(a.root)], [...before[0]], "A's tree changed only where the test wrote");
    assert.deepEqual([...listing(b.root)], [...before[1]], "B's tree changed only where the test wrote");
    assert.deepEqual(engineLines, [], "the engines logged problems");
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
}

test("two nodes in shadow mode agree over the direct listener, find a real difference, write nothing and stay quiet", { timeout: 240_000 }, (t) => runPair(t, "direct"));

test("with the listener off, the same works through the main server's routes", { timeout: 240_000 }, (t) => runPair(t, "relay"));
