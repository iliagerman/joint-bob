import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { FileSyncStatusAnswer } from "../src/file-sync/index.js";
import type { PeerShareStatus, ShareStatus } from "../src/file-sync/protocol.js";
import { api, freePort, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode, type SignedIn } from "./dev-nodes.js";

/* P3 end to end on real nodes: two separately seeded one-node environments share a project and run
   the engine in builtin mode, set through the test-only phase route (POST /api/file-sync/test-phase,
   present only under NODE_ENV=test with JOINT_BOB_FILE_SYNC_TEST_PHASES=1). Files created, edited,
   chmodded, renamed and deleted on either side arrive on the other with the same bytes and modes;
   concurrent edits leave exactly one conflict copy, on both nodes; a renamed 1,000-file folder moves
   without its bytes crossing the network; a deletion lands in the receiver's trash; a mass delete reaches
   the other node at once, with no confirmation; and back in shadow mode nothing is written. */

const SETTLE_MS = 1_500;
const SYNC_TIMEOUT_MS = 90_000;

interface Node { label: string; node: SeededNode; session: SignedIn; root: string }

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

const ENGINE_TEMP = /^\.joint-bob-sync\..+\.tmp$/;

/** What syncs of a tree: type, mode and content of every path outside node_modules (the only ignored folder the test makes). */
function synced(root: string): Map<string, string> {
  const found = new Map<string, string>();
  // The engine writes while this reads: its temps come and go, and a path can go between the listing and the look.
  const quiet = <T>(read: () => T): T | undefined => {
    try { return read(); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return undefined; throw error; }
  };
  const walk = (relative: string): void => {
    for (const name of (quiet(() => readdirSync(path.join(root, relative))) ?? []).sort()) {
      const key = relative ? `${relative}/${name}` : name;
      if (key === "node_modules" || ENGINE_TEMP.test(name)) continue;
      const absolute = path.join(root, key);
      const st = quiet(() => lstatSync(absolute));
      if (!st) continue;
      if (st.isSymbolicLink()) found.set(key, `link ${quiet(() => readlinkSync(absolute))}`);
      else if (st.isDirectory()) { found.set(key, `dir ${(st.mode & 0o777).toString(8)}`); walk(key); }
      else found.set(key, `file ${(st.mode & 0o777).toString(8)} ${st.size} ${quiet(() => sha(readFileSync(absolute)))}`);
    }
  };
  walk("");
  return found;
}

/** Every path under root, ignored ones included, with what any write would change. */
function fingerprint(root: string): Map<string, string> {
  const found = new Map<string, string>();
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

/** The trash of a node's engine: <dataDir>/file-sync/trash/<fsId>/<day>/<shareHash>/<path>, as [path, sha256] pairs. */
function trashed(node: SeededNode): Array<[string, string]> {
  const base = path.join(node.dataDir, "file-sync", "trash");
  const found: Array<[string, string]> = [];
  const walk = (directory: string, segments: string[]): void => {
    if (!existsSync(directory)) return;
    for (const name of readdirSync(directory)) {
      const absolute = path.join(directory, name);
      const st = lstatSync(absolute);
      if (st.isDirectory()) walk(absolute, [...segments, name]);
      else if (st.isFile()) found.push([[...segments.slice(3), name].join("/"), sha(readFileSync(absolute))]);
    }
  };
  walk(base, []);
  return found;
}

function inTrash(node: SeededNode, relative: string, content: string): boolean {
  const wanted = sha(content);
  // A collision in the trash adds ~N to a name.
  return trashed(node).some(([file, hash]) => hash === wanted && (file === relative || file.replace(/~\d+$/, "") === relative));
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

function received(answer: FileSyncStatusAnswer, projectId: string, peer: string): number {
  const transfer = peerOf(answer, projectId, peer)?.transfer;
  return (transfer?.directBytes ?? 0) + (transfer?.relayBytes ?? 0);
}

function describe(answer: FileSyncStatusAnswer, projectId: string): string {
  const share = projectShare(answer, projectId);
  return JSON.stringify(share ? { state: share.state, phase: share.phase, message: share.message, need: share.need, blocked: share.blocked, errors: share.errors, peers: share.peers.map((peer) => ({ caughtUp: peer.caughtUp, cursor: peer.cursor, peerMaxSeq: peer.peerMaxSeq, transfer: peer.transfer })) } : answer.shares);
}

/** Both trees hold the same synced content and both engines are done: idle, caught up, nothing needed, nothing blocked. */
async function converged(sides: [Node, Node], projectId: string, check?: (trees: [Map<string, string>, Map<string, string>]) => boolean): Promise<[FileSyncStatusAnswer, FileSyncStatusAnswer]> {
  let last: { answers: FileSyncStatusAnswer[]; trees: Array<Map<string, string>> } | undefined;
  const done = await until(async () => {
    const answers = await Promise.all(sides.map(status));
    const trees = sides.map((side) => synced(side.root));
    last = { answers, trees };
    return { answers, trees };
  }, ({ answers, trees }) => {
    const settled = answers.every((answer, index) => {
      const share = projectShare(answer, projectId);
      const peer = peerOf(answer, projectId, sides[1 - index].node.nodeId);
      return share?.state === "idle" && share.need.files === 0 && share.blocked === 0 && peer?.caughtUp === true;
    });
    return settled && JSON.stringify([...trees[0]]) === JSON.stringify([...trees[1]]) && (check?.(trees as [Map<string, string>, Map<string, string>]) ?? true);
  }, SYNC_TIMEOUT_MS);
  const [treeA, treeB] = done.trees;
  const onlyA = [...treeA].filter(([key, value]) => treeB.get(key) !== value);
  const onlyB = [...treeB].filter(([key, value]) => treeA.get(key) !== value);
  assert.deepEqual([onlyA.slice(0, 10), onlyB.slice(0, 10)], [[], []], `the trees differ: A ${describe(last!.answers[0], projectId)} B ${describe(last!.answers[1], projectId)}`);
  for (const [index, answer] of done.answers.entries()) {
    const share = projectShare(answer, projectId);
    assert.deepEqual([share?.state, share?.need.files, share?.blocked], ["idle", 0, 0], `${sides[index].label}: ${describe(answer, projectId)}`);
  }
  if (check) assert.ok(check(done.trees as [Map<string, string>, Map<string, string>]), "the expected change arrived");
  return done.answers as [FileSyncStatusAnswer, FileSyncStatusAnswer];
}

async function setPhase(side: Node, projectId: string, phase: "builtin" | "syncthing"): Promise<void> {
  const answer = await api<FileSyncStatusAnswer>(side.node, side.session, "POST", "/file-sync/test-phase", { projectId, phase });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(projectShare(answer.body, projectId)?.phase ?? phase, phase);
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
}

function manyFiles(prefix: string, count: number, tag: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (let index = 0; index < count; index++) files[`${prefix}/${String(Math.floor(index / 100)).padStart(2, "0")}/f${index}.txt`] = `${tag} ${index}\n`;
  return files;
}

async function runPair(t: TestContext): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "file-sync-builtin-")));
  const children: ChildProcess[] = [];
  const engineLines: string[] = [];
  try {
    const envA = await seedDevEnvironment(path.join(root, "a"), 1), envB = await seedDevEnvironment(path.join(root, "b"), 1);
    const [portA, portB] = await Promise.all([freePort(), freePort()]);
    const engine = (port: number) => ({
      JOINT_BOB_FILE_SYNC: "1", JOINT_BOB_FILE_SYNC_SETTLE_MS: String(SETTLE_MS), JOINT_BOB_FILE_SYNC_PORT: String(port),
      JOINT_BOB_FILE_SYNC_LISTEN: "127.0.0.1", JOINT_BOB_FILE_SYNC_TEST_PHASES: "1",
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

    // A's project: a few files of every kind, an ignored folder, and 1,100 files of ballast for the mass delete at the end.
    await writeFiles(a.root, {
      "README.md": "# Builtin nodes\n", "src/index.ts": "export const answer = 41;\n", "src/util.ts": "export const util = true;\n",
      "docs/old.md": "old notes\n", "docs/b-deletes.md": "B deletes this\n", "notes.txt": "notes\n", "scripts/run.sh": "#!/bin/sh\necho run\n", "conflict.txt": "base\n",
      "node_modules/pkg/index.js": "module.exports = 1;\n", ...manyFiles("ballast", 1_100, "ballast"),
    });
    await symlink("README.md", path.join(a.root, "readme-link"));
    const created = await api<{ project: { id: string } }>(a.node, a.session, "POST", "/projects", { name: "Builtin nodes", type: "personal", path: a.root, synced: true });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const projectId = created.body.project.id;
    const listed = await until(() => api<{ projects: Array<{ id: string; path: string }> }>(b.node, b.session, "GET", "/projects?syncStatus=false"),
      (answer) => answer.body.projects?.some((project) => project.id === projectId) ?? false, 30_000);
    const replica = listed.body.projects?.find((project) => project.id === projectId);
    assert.ok(replica?.path, `B lists the project with its own folder: ${JSON.stringify(listed.body)}`);
    b.root = replica.path;
    assert.notEqual(b.root, a.root);

    // Shadow first (as a node runs before the switch), then builtin on both through the test-only route.
    for (const side of [a, b]) {
      const configured = await api<FileSyncStatusAnswer>(side.node, side.session, "PUT", "/file-sync/config", { shadowProjects: [projectId] });
      assert.equal(configured.status, 200, JSON.stringify(configured.body));
      assert.equal(configured.body.worker, "running");
    }
    for (const side of [a, b]) await setPhase(side, projectId, "builtin");

    // 1. B's folder fills with A's files: same bytes, modes and link; the ignored folder stays on A.
    const started = Date.now();
    await converged([a, b], projectId);
    t.diagnostic(`initial copy of ${synced(a.root).size} paths in ${Date.now() - started} ms`);
    assert.equal(existsSync(path.join(b.root, "node_modules")), false, "an ignored folder never syncs");
    assert.equal(readlinkSync(path.join(b.root, "readme-link")), "README.md");

    // 2. Both sides change things at once: edits, a chmod, a new folder, a delete, renames.
    await writeFile(path.join(a.root, "src", "index.ts"), "export const answer = 42;\n");
    await chmod(path.join(a.root, "scripts", "run.sh"), 0o755);
    await writeFiles(a.root, { "lib/new/deep.ts": "export const deep = 1;\n" });
    await rm(path.join(a.root, "docs", "old.md"));
    await mkdir(path.join(a.root, "archive"));
    await rename(path.join(a.root, "notes.txt"), path.join(a.root, "archive", "notes.txt"));
    await writeFiles(b.root, { "from-b.txt": "written on B\n" });
    await writeFile(path.join(b.root, "README.md"), "# Builtin nodes, edited on B\n");
    await chmod(path.join(b.root, "src", "util.ts"), 0o600);
    await rename(path.join(b.root, "src", "util.ts"), path.join(b.root, "src", "helpers.ts"));
    await rm(path.join(b.root, "docs", "b-deletes.md"));
    await converged([a, b], projectId, ([treeA]) => treeA.has("from-b.txt") && treeA.has("src/helpers.ts") && !treeA.has("src/util.ts") && treeA.has("lib/new/deep.ts")
      && treeA.has("archive/notes.txt") && !treeA.has("docs/b-deletes.md"));
    assert.equal(await readFile(path.join(b.root, "src", "index.ts"), "utf8"), "export const answer = 42;\n");
    assert.equal(lstatSync(path.join(b.root, "scripts", "run.sh")).mode & 0o777, 0o755, "a chmod arrives");
    assert.equal(lstatSync(path.join(a.root, "src", "helpers.ts")).mode & 0o777, 0o600, "a mode arrives with a rename");
    assert.equal(existsSync(path.join(b.root, "docs", "old.md")), false);
    // What a peer's change replaced or deleted is kept in the receiver's trash (invariant 5).
    assert.ok(inTrash(b.node, "docs/old.md", "old notes\n"), `B keeps the file A deleted: ${JSON.stringify(trashed(b.node))}`);
    assert.ok(inTrash(b.node, "src/index.ts", "export const answer = 41;\n"), "B keeps the version A's edit replaced");
    assert.ok(inTrash(a.node, "README.md", "# Builtin nodes\n"), "A keeps the version B's edit replaced");
    assert.ok(inTrash(a.node, "docs/b-deletes.md", "B deletes this\n"), "A keeps the file B deleted");

    // 3. The same file edited on both sides before either hears of the other: one conflict copy, on both nodes.
    await Promise.all([writeFile(path.join(a.root, "conflict.txt"), "edited on A\n"), writeFile(path.join(b.root, "conflict.txt"), "edited on B\n")]);
    const copies = (tree: Map<string, string>) => [...tree.keys()].filter((key) => /^conflict\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]{7}\.txt$/.test(key));
    await converged([a, b], projectId, ([treeA]) => copies(treeA).length > 0);
    const [copyA, copyB] = [copies(synced(a.root)), copies(synced(b.root))];
    assert.equal(copyA.length, 1, `exactly one conflict copy: ${copyA.join(", ")}`);
    assert.deepEqual(copyB, copyA, "the loser's copy reached the winner");
    const contents = new Set([await readFile(path.join(a.root, "conflict.txt"), "utf8"), await readFile(path.join(a.root, copyA[0]), "utf8")]);
    assert.deepEqual(contents, new Set(["edited on A\n", "edited on B\n"]), "both versions are kept, one as the file and one as its copy");

    // 4. A renamed 1,000-file folder: the files move on B, and their bytes do not cross the network again.
    await writeFiles(a.root, manyFiles("many", 1_000, "many"));
    await converged([a, b], projectId, ([treeA]) => treeA.has("many/09/f999.txt"));
    const before = received(await status(b), projectId, a.node.nodeId);
    const folderBytes = Object.values(manyFiles("many", 1_000, "many")).reduce((sum, content) => sum + Buffer.byteLength(content), 0);
    await rename(path.join(a.root, "many"), path.join(a.root, "moved"));
    const [, afterB] = await converged([a, b], projectId, ([, treeB]) => treeB.has("moved/09/f999.txt") && !treeB.has("many"));
    const movedBytes = received(afterB, projectId, a.node.nodeId) - before;
    t.diagnostic(`a 1,000-file rename moved ${movedBytes} bytes over the network (the folder holds ${folderBytes})`);
    assert.ok(movedBytes <= folderBytes / 100, `the rename transferred ${movedBytes} of ${folderBytes} bytes`);

    // 5. A worktree-like mass delete (2,100 files, nearly all of the share) reaches B at once, into B's trash: deletions
    //    are never held or confirmed (2.155.2).
    await rm(path.join(a.root, "moved"), { recursive: true });
    await rm(path.join(a.root, "ballast"), { recursive: true });
    await converged([a, b], projectId, ([, treeB]) => !treeB.has("moved") && !treeB.has("ballast"));
    assert.ok(inTrash(b.node, "moved/09/f999.txt", "many 999\n"), "the deletions are in B's trash");
    assert.ok(inTrash(b.node, "ballast/10/f1099.txt", "ballast 1099\n"), "every deleted folder's files are in B's trash");
    assert.deepEqual(engineLines.filter((line) => /\b(held|hold|confirm)/i.test(line)), [], "nothing about the deletions waits for anyone");

    // 6. Back in shadow mode: a change on A is a difference on B, and B's tree is not touched.
    for (const side of [a, b]) await setPhase(side, projectId, "syncthing");
    const untouched = fingerprint(b.root);
    await writeFile(path.join(a.root, "src", "index.ts"), "export const answer = 43;\n");
    const differing = await until(() => status(b), (answer) => peerOf(answer, projectId, a.node.nodeId)?.differences === 1, 30_000);
    assert.equal(peerOf(differing, projectId, a.node.nodeId)?.differences, 1, `B sees the change as a difference: ${describe(differing, projectId)}`);
    assert.equal(projectShare(differing, projectId)?.phase, "syncthing");
    assert.deepEqual([...fingerprint(b.root)], [...untouched], "in shadow mode the engine wrote nothing into B's tree");
    if (engineLines.length) t.diagnostic(`engine log lines: ${engineLines.slice(0, 20).join(" | ")}`);
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
}

test("two nodes in builtin mode sync edits, conflicts, renames and deletions, and write nothing back in shadow mode", { timeout: 600_000 }, (t) => runPair(t));
