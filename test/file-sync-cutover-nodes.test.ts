import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createDecipheriv, createHash, createPrivateKey, type KeyObject } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { FileSyncStatusAnswer } from "../src/file-sync/index.js";
import type { Check, ChecksAnswer, FileSyncProject } from "../src/file-sync/migration.js";
import type { PeerShareStatus, ShareStatus } from "../src/file-sync/protocol.js";
import { signRequest } from "../src/file-sync/signing.js";
import type { ProjectSyncStatus } from "../src/types.js";
import { api, freePort, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";

/* P5 end to end on real nodes: two separately seeded one-node environments share a project, each
   with its own fake Syncthing (a REST server in this process that records every folder added and
   removed and moves no files: the test plays Syncthing's copying). The owner moves the project with
   POST /api/file-sync/engine; both nodes walk releasing → bootstrapping → builtin, the bootstrap keeps
   every file whatever side held it, with one conflict copy for a file both sides changed, and Syncthing
   lets go of exactly the project's folders. Then the engine moves edits, deletions (into the trash) and
   renames; a handoff that says the source is further on keeps the receiver "syncing" until the file
   arrived; a move back stops the engine writing and gives Syncthing its folders again; and a node
   stopped while releasing, and again while bootstrapping, resumes where it was. The checks refuse while
   files differ and while the other machine has file sync off. */

const SETTLE_MS = 20_000;
const SYNC_TIMEOUT_MS = 120_000;
const ENGINE_TEMP = /^\.joint-bob-sync\..+\.tmp$/;
const CONFLICT_COPY = /^differs\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]{7}\.txt$/;

interface Side {
  label: string;
  env: DevEnvironment;
  node: SeededNode;
  session: SignedIn;
  root: string;
  ticketRoot: string;
  worktreeRoot: string;
  syncthing: FakeSyncthing;
  child?: ChildProcess;
  extraEnv: Record<string, string>;
  lines: string[];
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number, everyMs = 200): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/* ---- the fake Syncthing: folders, devices and ignore lists in memory; every daemon answer a node asks for ---- */

interface FakeFolder { id: string; label: string; path: string; type: string; devices: Array<{ deviceID: string }>; paused?: boolean; [key: string]: unknown }

class FakeSyncthing {
  readonly folders = new Map<string, FakeFolder>();
  readonly devices: Array<{ deviceID: string; name?: string; addresses?: string[] }> = [];
  readonly ignores = new Map<string, string[]>();
  /** "add <id>", "update <id>", "remove <id>", in order. */
  readonly log: string[] = [];
  /** A daemon that does not let go: a DELETE answers OK and the folder stays. */
  hold = false;
  url = "";
  private server?: Server;
  /** auto-transition: its event stream (/rest/events, long-polled): a ConfigSaved for every folder change. */
  private readonly events: Array<{ id: number; type: string; data?: unknown }> = [];
  private readonly waiters = new Set<() => void>();

  constructor(readonly myID: string) {}

  add(folder: Omit<FakeFolder, "type" | "devices"> & Partial<FakeFolder>): void { this.folders.set(folder.id, { type: "sendreceive", devices: [], ...folder }); this.publish("ConfigSaved"); }

  private publish(type: string, data?: unknown): void {
    this.events.push({ id: this.events.length + 1, type, ...(data === undefined ? {} : { data }) });
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  removed(): string[] { return [...new Set(this.log.filter((entry) => entry.startsWith("remove ")).map((entry) => entry.slice(7)))].sort(); }
  added(after = 0): string[] { return this.log.slice(after).filter((entry) => entry.startsWith("add ")).map((entry) => entry.slice(4)); }

  async start(): Promise<void> {
    this.server = createServer((request, response) => { void this.handle(request, response); });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  close(): Promise<void> {
    const server = this.server;
    // Long polls end now, so no timer outlives the test.
    for (const wake of this.waiters) wake();
    this.waiters.clear();
    if (!server) return Promise.resolve();
    server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text ? JSON.parse(text) as Record<string, unknown> : undefined;
    const url = new URL(request.url ?? "/", "http://syncthing");
    const send = (value?: unknown) => { response.setHeader("Content-Type", "application/json"); response.end(value === undefined ? "" : JSON.stringify(value)); };
    const method = request.method ?? "GET";
    const folderParam = url.searchParams.get("folder") ?? "";
    const tail = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    switch (url.pathname) {
      case "/rest/system/status": return send({ myID: this.myID, connectionServiceStatus: {} });
      case "/rest/system/connections": return send({ connections: Object.fromEntries(this.devices.map((device) => [device.deviceID, { connected: true }])) });
      case "/rest/config/devices":
        if (method === "POST" && body) this.devices.push(body as { deviceID: string });
        return send(method === "GET" ? this.devices : undefined);
      case "/rest/config/folders":
        if (method === "GET") return send([...this.folders.values()]);
        if (method === "POST" && body) { this.folders.set(String(body.id), body as FakeFolder); this.log.push(`add ${String(body.id)}`); this.publish("ConfigSaved"); }
        return send();
      case "/rest/db/ignores":
        if (method === "POST" && body) this.ignores.set(folderParam, (body.ignore as string[]) ?? []);
        return send(method === "GET" ? { ignore: this.ignores.get(folderParam) ?? [] } : undefined);
      case "/rest/db/scan": return send();
      case "/rest/db/status": return send({ state: this.folders.get(folderParam)?.paused ? "paused" : "idle", needTotalItems: 0, needBytes: 0, errors: 0 });
      case "/rest/db/completion": return send({ completion: 100, needItems: 0, needBytes: 0, needDeletes: 0, remoteState: "valid" });
      case "/rest/folder/errors": return send({ errors: [] });
      case "/rest/events": {
        const since = Number(url.searchParams.get("since") ?? 0), timeout = Number(url.searchParams.get("timeout") ?? 60), limit = Number(url.searchParams.get("limit") ?? 0);
        const pick = () => { const fresh = this.events.filter((event) => event.id > since); return limit > 0 ? fresh.slice(-limit) : fresh; };
        if (!pick().length && timeout > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, timeout * 1000);
            this.waiters.add(() => { clearTimeout(timer); resolve(); });
          });
        }
        return send(pick());
      }
    }
    if (url.pathname.startsWith("/rest/config/devices/") && method === "PATCH" && body) {
      const device = this.devices.find((candidate) => candidate.deviceID === tail);
      if (device) Object.assign(device, body);
      return send();
    }
    if (url.pathname.startsWith("/rest/config/folders/")) {
      const held = this.folders.get(tail);
      if (method === "DELETE") {
        this.log.push(`remove ${tail}`);
        if (!this.hold) { this.folders.delete(tail); this.publish("ConfigSaved"); }
        return send();
      }
      if ((method === "PUT" || method === "PATCH") && body) {
        this.folders.set(tail, method === "PUT" ? body as FakeFolder : { ...held!, ...body } as FakeFolder);
        this.log.push(`${held ? "update" : "add"} ${tail}`);
        this.publish("ConfigSaved");
        return send();
      }
      if (method === "GET" && held) return send(held);
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  }
}

/* ---- trees, trash and statuses (as test/file-sync-builtin-nodes.test.ts reads them) ---- */

/** What syncs of a tree: type, mode and content of every path outside node_modules (the only ignored folder the test makes). */
function synced(root: string): Map<string, string> {
  const found = new Map<string, string>();
  const quiet = <T>(read: () => T): T | undefined => {
    try { return read(); } catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined; throw error; }
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

/** The engine's trash: <dataDir>/file-sync/trash/<fsId>/<day>/<shareHash>/<path>, as [path, sha256] pairs. */
function trashed(node: SeededNode): Array<[string, string]> {
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
  walk(path.join(node.dataDir, "file-sync", "trash"), []);
  return found;
}

function inTrash(node: SeededNode, relative: string, content: string): boolean {
  const wanted = sha(content);
  return trashed(node).some(([file, hash]) => hash === wanted && (file === relative || file.replace(/~\d+$/, "") === relative));
}

async function status(side: Side): Promise<FileSyncStatusAnswer> {
  const answer = await api<FileSyncStatusAnswer>(side.node, side.session, "GET", "/file-sync/status");
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body;
}

function shareOf(answer: FileSyncStatusAnswer, projectId: string, kind = "project"): ShareStatus | undefined {
  return answer.shares.find((share) => share.projectId === projectId && share.kind === kind);
}

function peerOf(answer: FileSyncStatusAnswer, projectId: string, peer: string, kind = "project"): PeerShareStatus | undefined {
  return shareOf(answer, projectId, kind)?.peers.find((candidate) => candidate.peer === peer);
}

function describe(answer: FileSyncStatusAnswer, projectId: string): string {
  return JSON.stringify(answer.shares.filter((share) => share.projectId === projectId).map((share) => ({
    kind: share.kind, state: share.state, phase: share.phase, engine: share.engine, message: share.message, need: share.need, blocked: share.blocked, errors: share.errors, builtinSince: share.builtinSince,
    peers: share.peers.map((peer) => ({ caughtUp: peer.caughtUp, cursor: peer.cursor, peerMaxSeq: peer.peerMaxSeq, differences: peer.differences, builtinSince: peer.builtinSince })),
  })));
}

/** Both trees hold the same synced content and both engines are done with every folder of the project. */
async function converged(sides: [Side, Side], projectId: string, check?: (trees: [Map<string, string>, Map<string, string>]) => boolean): Promise<[FileSyncStatusAnswer, FileSyncStatusAnswer]> {
  let last: { answers: FileSyncStatusAnswer[]; trees: Array<Map<string, string>> } | undefined;
  const done = await until(async () => {
    last = { answers: await Promise.all(sides.map(status)), trees: sides.map((side) => synced(side.root)) };
    return last;
  }, ({ answers, trees }) => answers.every((answer, index) => ["project", "tickets", "worktrees"].every((kind) => {
    const share = shareOf(answer, projectId, kind);
    return share?.state === "idle" && share.need.files === 0 && share.blocked === 0 && peerOf(answer, projectId, sides[1 - index].node.nodeId, kind)?.caughtUp === true;
  })) && JSON.stringify([...trees[0]]) === JSON.stringify([...trees[1]]) && (check?.(trees as [Map<string, string>, Map<string, string>]) ?? true), SYNC_TIMEOUT_MS, 300);
  const [treeA, treeB] = done.trees;
  const onlyA = [...treeA].filter(([key, value]) => treeB.get(key) !== value);
  const onlyB = [...treeB].filter(([key, value]) => treeA.get(key) !== value);
  assert.deepEqual([onlyA.slice(0, 10), onlyB.slice(0, 10)], [[], []], `the trees differ: A ${describe(last!.answers[0], projectId)} B ${describe(last!.answers[1], projectId)}`);
  for (const [index, answer] of done.answers.entries()) {
    const share = shareOf(answer, projectId);
    assert.deepEqual([share?.state, share?.need.files, share?.blocked], ["idle", 0, 0], `${sides[index].label}: ${describe(answer, projectId)}`);
  }
  if (check) assert.ok(check(done.trees as [Map<string, string>, Map<string, string>]), `the expected change arrived: A ${describe(last!.answers[0], projectId)} B ${describe(last!.answers[1], projectId)}`);
  return done.answers as [FileSyncStatusAnswer, FileSyncStatusAnswer];
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
}

/* ---- the switch's API ---- */

async function project(side: Side, projectId: string): Promise<FileSyncProject | undefined> {
  const answer = await api<{ projects: FileSyncProject[] }>(side.node, side.session, "GET", "/file-sync/projects");
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body.projects.find((candidate) => candidate.projectId === projectId);
}

async function checks(side: Side, projectId: string, engine: "builtin" | "syncthing" = "builtin"): Promise<ChecksAnswer> {
  const answer = await api<ChecksAnswer>(side.node, side.session, "GET", `/file-sync/engine/checks?projectId=${encodeURIComponent(projectId)}&engine=${engine}`);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body;
}

const failing = (answer: { checks: Check[] }): string[] => answer.checks.filter((check) => !check.ok).map((check) => check.key);
const checkText = (answer: { checks: Check[] }): string => answer.checks.map((check) => `${check.ok ? "✓" : "✗"} ${check.key}: ${check.message}`).join(" | ");

async function switchEngine(side: Side, projectId: string, engine: "builtin" | "syncthing"): Promise<{ status: number; body: { project?: FileSyncProject; error?: string; checks?: Check[] } }> {
  return api(side.node, side.session, "POST", "/file-sync/engine", { projectId, engine });
}

/** Polls both nodes' phase of the project until `done`; returns the distinct phases each was seen in, in order. */
async function watchPhases(sides: Side[], projectId: string, done: (projects: Array<FileSyncProject | undefined>) => boolean, timeoutMs: number): Promise<{ seen: string[][]; last: Array<FileSyncProject | undefined> }> {
  const seen = sides.map(() => [] as string[]);
  const last = await until(async () => {
    const projects = await Promise.all(sides.map((side) => project(side, projectId)));
    projects.forEach((entry, index) => { const phase = entry?.phase ?? "none"; if (seen[index].at(-1) !== phase) seen[index].push(phase); });
    return projects;
  }, done, timeoutMs, 100);
  return { seen, last };
}

const ORDER = ["syncthing", "releasing", "bootstrapping", "builtin"];
function inOrder(phases: readonly string[]): boolean {
  return phases.every((phase, index) => ORDER.includes(phase) && (index === 0 || ORDER.indexOf(phase) > ORDER.indexOf(phases[index - 1])));
}

/* ---- a handoff source's signed request, as node A's own server would send it ---- */

function privateKeyOf(node: SeededNode): KeyObject {
  const configured = process.env.JOINT_BOB_SECRET_KEY ?? process.env.MASTER_BOB_SECRET_KEY;
  const key = Buffer.from(configured ?? readFileSync(path.join(node.dataDir, "secret.key"), "utf8").trim(), "base64");
  const db = new DatabaseSync(path.join(node.dataDir, "node.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT private_key_encrypted FROM cluster_v2_identity WHERE singleton = 1").get() as { private_key_encrypted: string };
    const [iv, tag, body] = row.private_key_encrypted.split(".");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return createPrivateKey(Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8"));
  } finally { db.close(); }
}

interface Eligibility { eligible: boolean; reasons: string[]; syncStatuses: Array<ProjectSyncStatus & { label: string }>; waitingForSync: boolean }

/** The handoff dialog's question to the destination, carrying how far the source's index reached (design §6.5). */
async function askEligibility(from: Side, key: KeyObject, to: Side, projectId: string, fileSync: unknown): Promise<Eligibility> {
  const target = "/api/cluster/v2/runtime/tasks/eligibility";
  const body = Buffer.from(JSON.stringify({ projectId, task: { id: "handoff-probe", engine: "pi", currentNodeId: from.node.nodeId }, source: true, fileSync }));
  const response = await fetch(`${to.node.url}${target}`, {
    method: "POST", body, headers: { "Content-Type": "application/json", Authorization: signRequest(key, from.node.nodeId, to.node.nodeId, "POST", target, body) },
  });
  const answer = await response.json() as Eligibility;
  assert.equal(response.status, 200, JSON.stringify(answer));
  return answer;
}

/* ---- nodes ---- */

async function startSide(side: Side): Promise<void> {
  side.child = await startDevNode(side.env, side.node, side.extraEnv);
  for (const stream of [side.child.stdout!, side.child.stderr!]) {
    stream.on("data", (chunk: Buffer) => side.lines.push(...String(chunk).split("\n").filter((line) => /File (sync|scan)|Syncthing|switch/i.test(line)).map((line) => `${side.label}: ${line}`)));
  }
  side.session = await signIn(side.env, side.node);
}

async function restart(side: Side, between?: () => Promise<void>): Promise<void> {
  if (side.child) await stopDevNode(side.child);
  side.child = undefined;
  await between?.();
  await startSide(side);
}

function projectFolders(side: Side, projectId: string): FakeFolder[] {
  const roots = [side.root, path.join(side.ticketRoot, projectId), path.join(side.worktreeRoot, projectId)];
  return [...side.syncthing.folders.values()].filter((folder) => roots.includes(folder.path));
}

const lines = (sides: Side[]): string => sides.flatMap((side) => side.lines.slice(-15)).join("\n");

async function runCutover(t: TestContext): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "file-sync-cutover-")));
  const sides: Side[] = [];
  try {
    const [envA, envB] = await Promise.all([seedDevEnvironment(path.join(root, "a"), 1), seedDevEnvironment(path.join(root, "b"), 1)]);
    const make = async (label: string, env: DevEnvironment, device: string): Promise<Side> => {
      const syncthing = new FakeSyncthing(device);
      await syncthing.start();
      const ticketRoot = path.join(root, `${label.toLowerCase()}-tickets`), worktreeRoot = path.join(root, `${label.toLowerCase()}-worktrees`);
      await mkdir(ticketRoot, { recursive: true });
      // Untouchable: the user's own folder, and the old shared ticket folder Joint Bob keeps paused (it covers every project's tickets).
      syncthing.add({ id: "user-photos", label: "Photos", path: path.join(root, `${label.toLowerCase()}-photos`) });
      syncthing.add({ id: "joint-bob-ticket-workspaces", label: "Joint Bob ticket workspaces", path: ticketRoot, paused: true });
      const port = await freePort();
      return {
        label, env, node: env.nodes[0], session: undefined as unknown as SignedIn, root: "", ticketRoot, worktreeRoot, syncthing, lines: [],
        extraEnv: {
          JOINT_BOB_FILE_SYNC_SETTLE_MS: String(SETTLE_MS), JOINT_BOB_FILE_SYNC_PORT: String(port), JOINT_BOB_FILE_SYNC_LISTEN: "127.0.0.1",
          JOINT_BOB_SYNCTHING_URL: syncthing.url, JOINT_BOB_SYNCTHING_API_KEY: "test-key", JOINT_BOB_TICKET_ROOT: ticketRoot, JOINT_BOB_WORKTREE_ROOT: worktreeRoot,
        },
      };
    };
    const a = await make("A", envA, "AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA");
    const b = await make("B", envB, "BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB");
    sides.push(a, b);
    await Promise.all([startSide(a), startSide(b)]);
    a.root = path.join(root, "project");
    const invitation = await api<{ link: string }>(a.node, a.session, "POST", "/twins/invitations", { confirmOwnedData: true });
    assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
    const accepted = await api(b.node, b.session, "POST", "/twins/accept", { link: invitation.body.link, confirmOwnedData: true });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));

    const base = {
      "README.md": "# Cutover nodes\n", "src/index.ts": "export const answer = 41;\n", "docs/old.md": "old notes\n", "notes.txt": "notes\n",
      "differs.txt": "base\n", "keep/deep/file.txt": "deep\n",
    };
    await writeFiles(a.root, { ...base, "node_modules/pkg/index.js": "module.exports = 1;\n" });
    const created = await api<{ project: { id: string } }>(a.node, a.session, "POST", "/projects", { name: "Cutover nodes", type: "personal", path: a.root, synced: true });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const projectId = created.body.project.id;
    const listed = await until(() => api<{ projects: Array<{ id: string; path: string }> }>(b.node, b.session, "GET", "/projects?syncStatus=false"),
      (answer) => answer.body.projects?.some((candidate) => candidate.id === projectId) ?? false, 30_000);
    b.root = listed.body.projects?.find((candidate) => candidate.id === projectId)?.path ?? "";
    assert.ok(b.root && b.root !== a.root, `B lists the project with its own folder: ${JSON.stringify(listed.body)}`);
    // Syncthing's part: the same files on B.
    await writeFiles(b.root, base);

    // File sync on, the project checked in shadow mode beside Syncthing (the environment does not force the switch, so B can turn it off later).
    for (const side of [a, b]) {
      const configured = await api<FileSyncStatusAnswer>(side.node, side.session, "PUT", "/file-sync/config", { enabled: true, shadowProjects: [projectId] });
      assert.equal(configured.status, 200, JSON.stringify(configured.body));
      const running = await until(() => status(side), (answer) => answer.worker === "running", 30_000);
      assert.equal(running.worker, "running");
    }
    // Enrollment gives each Syncthing the project's three folders.
    for (const side of [a, b]) {
      await until(async () => projectFolders(side, projectId), (folders) => folders.length === 3, 60_000, 500);
      assert.equal(projectFolders(side, projectId).length, 3, `${side.label}'s Syncthing holds the project's folders: ${JSON.stringify([...side.syncthing.folders.values()].map((folder) => [folder.id, folder.path]))}`);
    }
    const ownFolders = new Map(sides.map((side) => [side, projectFolders(side, projectId).map((folder) => folder.id).sort()]));

    // 1. The checks pass once both sides compared every folder; the time the files have matched is shown, never checked.
    const ready = await until(() => checks(a, projectId), (answer) => !failing(answer).length, 90_000, 500);
    assert.deepEqual(failing(ready), [], checkText(ready));
    assert.ok(!ready.checks.some((check) => /clean|days|week/i.test(check.key)), `no check waits for days without differences: ${checkText(ready)}`);
    const notOwner = await checks(b, projectId);
    assert.ok(failing(notOwner).includes("owner"), `only the owner may move it: ${checkText(notOwner)}`);

    // 2. A file only A has, once it outlives the settle window, fails the differences check; Syncthing copying it clears it.
    await writeFiles(a.root, { "probe.txt": "probe\n" });
    const differing = await until(() => checks(a, projectId), (answer) => failing(answer).includes("differences"), SETTLE_MS + 30_000, 1_000);
    assert.ok(failing(differing).includes("differences"), checkText(differing));
    assert.match(differing.checks.find((check) => check.key === "differences")!.message, /1 file differs with/);
    const refused = await switchEngine(a, projectId, "builtin");
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.ok(refused.body.checks?.some((check) => check.key === "differences" && !check.ok), JSON.stringify(refused.body));
    assert.equal((await project(a, projectId))?.engine, "syncthing", "a refused move records nothing");
    await writeFiles(b.root, { "probe.txt": "probe\n" });
    const cleared = await until(() => checks(a, projectId), (answer) => !failing(answer).length, 60_000, 500);
    assert.deepEqual(failing(cleared), [], checkText(cleared));

    // 3. File sync turned off on B fails the check that every machine runs it.
    const off = await api<FileSyncStatusAnswer>(b.node, b.session, "PUT", "/file-sync/config", { enabled: false });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    const peerOff = await until(() => checks(a, projectId), (answer) => failing(answer).includes("peers"), 30_000, 500);
    assert.ok(failing(peerOff).includes("peers"), checkText(peerOff));
    assert.match(peerOff.checks.find((check) => check.key === "peers")!.message, /file sync turned off|not running/);
    const on = await api<FileSyncStatusAnswer>(b.node, b.session, "PUT", "/file-sync/config", { enabled: true });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    const back = await until(() => checks(a, projectId), (answer) => !failing(answer).length, 90_000, 500);
    assert.deepEqual(failing(back), [], checkText(back));

    // 4. In-flight edits on both sides, as Syncthing would leave them mid-copy: still inside the settle window when the owner
    //    switches, and already in both engines' indexes, so each side's bootstrap decides with the other's entries in hand.
    const writtenAt = Date.now();
    await writeFiles(a.root, { "only-a.txt": "only on A\n", "dir-a/nested.txt": "nested on A\n", "same-new.txt": "same on both\n", "differs.txt": "A's version\n" });
    await writeFiles(b.root, { "only-b.txt": "only on B\n", "dir-b/nested.txt": "nested on B\n", "same-new.txt": "same on both\n", "differs.txt": "B's version\n" });
    const liveFiles = Object.keys(base).length + 1 + 3;
    const indexed = await until(() => Promise.all([status(a), status(b)]), (answers) => answers.every((answer, index) => {
      const own = shareOf(answer, projectId), other = shareOf(answers[1 - index], projectId), peer = peerOf(answer, projectId, sides[1 - index].node.nodeId);
      return own?.liveFiles === liveFiles && own.state === "idle" && peer?.caughtUp === true && peer.cursor >= (other?.maxSeq ?? Infinity);
    }), SETTLE_MS - 5_000);
    assert.ok(indexed.every((answer) => shareOf(answer, projectId)?.liveFiles === liveFiles), `both engines indexed the in-flight edits: A ${describe(indexed[0], projectId)} B ${describe(indexed[1], projectId)}`);
    t.diagnostic(`both indexes held the in-flight edits ${Date.now() - writtenAt} ms after they were written`);
    let switched: Awaited<ReturnType<typeof switchEngine>> | undefined;
    for (;;) {
      const current = await checks(a, projectId);
      if (!failing(current).length) {
        switched = await switchEngine(a, projectId, "builtin");
        if (switched.status === 200) break;
      }
      assert.ok(Date.now() - writtenAt < SETTLE_MS - 2_000, `the checks passed before the in-flight edits settled: ${checkText(current)} ${JSON.stringify(switched?.body)}`);
      await pause(300);
    }
    t.diagnostic(`switched ${Date.now() - writtenAt} ms after the in-flight edits`);
    assert.equal(switched.body.project?.engine, "builtin", JSON.stringify(switched.body));
    const moved = await watchPhases([a, b], projectId, (projects) => projects.every((entry) => entry?.phase === "builtin"), SYNC_TIMEOUT_MS);
    assert.deepEqual(moved.last.map((entry) => entry?.phase), ["builtin", "builtin"], `${JSON.stringify(moved)}\n${lines(sides)}`);
    for (const [index, phases] of moved.seen.entries()) assert.ok(inOrder(phases), `${sides[index].label} walked the phases in order: ${phases.join(" → ")}`);
    t.diagnostic(`phases seen: A ${moved.seen[0].join(" → ")}, B ${moved.seen[1].join(" → ")}`);
    assert.equal((await project(b, projectId))?.engine, "builtin", "B took the owner's record");

    // Every file on both sides, none deleted; the file both changed has exactly one conflict copy holding the other version.
    const copies = (tree: Map<string, string>) => [...tree.keys()].filter((key) => CONFLICT_COPY.test(key));
    const [afterA, afterB] = await converged([a, b], projectId, ([treeA]) => copies(treeA).length > 0);
    for (const side of [a, b]) {
      for (const file of [...Object.keys(base), "probe.txt", "only-a.txt", "dir-a/nested.txt", "only-b.txt", "dir-b/nested.txt", "same-new.txt"]) {
        assert.ok(existsSync(path.join(side.root, file)), `${side.label} has ${file}`);
      }
      assert.equal(await readFile(path.join(side.root, "only-a.txt"), "utf8"), "only on A\n");
      assert.equal(await readFile(path.join(side.root, "only-b.txt"), "utf8"), "only on B\n");
    }
    const [copyA, copyB] = [copies(synced(a.root)), copies(synced(b.root))];
    assert.equal(copyA.length, 1, `exactly one conflict copy: ${copyA.join(", ")}`);
    assert.deepEqual(copyB, copyA);
    assert.deepEqual(new Set([await readFile(path.join(a.root, "differs.txt"), "utf8"), await readFile(path.join(a.root, copyA[0]), "utf8")]), new Set(["A's version\n", "B's version\n"]));
    for (const [index, answer] of [afterA, afterB].entries()) {
      for (const kind of ["project", "tickets", "worktrees"]) assert.equal(typeof shareOf(answer, projectId, kind)?.builtinSince, "number", `${sides[index].label} recorded builtin_since for ${kind}: ${describe(answer, projectId)}`);
    }
    // Syncthing let go of exactly the project's folders on each node; the user's folder and the paused old folder are as they were.
    for (const side of [a, b]) {
      assert.deepEqual(side.syncthing.removed(), ownFolders.get(side), `${side.label}'s Syncthing lost only the project's folders: ${JSON.stringify(side.syncthing.log)}`);
      assert.deepEqual(projectFolders(side, projectId), [], `${side.label}: no folder of the project left`);
      assert.ok(side.syncthing.folders.has("user-photos"));
      assert.equal(side.syncthing.folders.get("joint-bob-ticket-workspaces")?.paused, true);
    }
    const logMark = new Map(sides.map((side) => [side, side.syncthing.log.length]));

    // 5. Edits, deletions and renames now travel with the engine; what a peer's change replaced or deleted is in the receiver's trash.
    await writeFile(path.join(a.root, "src", "index.ts"), "export const answer = 42;\n");
    await rename(path.join(a.root, "notes.txt"), path.join(a.root, "keep", "notes.txt"));
    await rm(path.join(b.root, "docs", "old.md"));
    await converged([a, b], projectId, ([treeA, treeB]) => treeA.get("src/index.ts") === treeB.get("src/index.ts") && treeB.has("keep/notes.txt") && !treeB.has("notes.txt") && !treeA.has("docs/old.md"));
    assert.equal(await readFile(path.join(b.root, "src", "index.ts"), "utf8"), "export const answer = 42;\n");
    assert.ok(inTrash(b.node, "src/index.ts", "export const answer = 41;\n"), `B keeps the version A's edit replaced: ${JSON.stringify(trashed(b.node))}`);
    assert.ok(inTrash(a.node, "docs/old.md", "old notes\n"), `A keeps the file B deleted: ${JSON.stringify(trashed(a.node))}`);

    // 6. A handoff from A that says A's index is one change further on: B reports "syncing" until that change (a file) arrived.
    const keyA = privateKeyOf(a.node);
    const aShare = shareOf(await status(a), projectId)!;
    const handoff = { projectId, shares: [{ kind: "project", indexId: aShare.indexId, maxSeq: aShare.maxSeq + 1 }] };
    for (let round = 0; round < 3; round++) {
      const waiting = await askEligibility(a, keyA, b, projectId, handoff);
      assert.equal(waiting.syncStatuses[0]?.state, "syncing", `B waits for A's newer files: ${JSON.stringify(waiting)}`);
      assert.equal(waiting.waitingForSync, true, JSON.stringify(waiting));
      await pause(1_000);
    }
    const projectStatus = await api<{ projects: Array<{ id: string; syncStatus?: ProjectSyncStatus }> }>(b.node, b.session, "GET", "/projects?syncStatus=true");
    assert.equal(projectStatus.body.projects.find((candidate) => candidate.id === projectId)?.syncStatus?.state, "syncing", `B's project shows it is catching up: ${JSON.stringify(projectStatus.body)}`);
    assert.equal(existsSync(path.join(b.root, "handoff.txt")), false);
    await writeFile(path.join(a.root, "handoff.txt"), "handed over\n");
    const arrived = await until(() => askEligibility(a, keyA, b, projectId, handoff), (answer) => answer.syncStatuses[0]?.state === "synced", 60_000, 500);
    assert.equal(arrived.syncStatuses[0]?.state, "synced", JSON.stringify(arrived));
    assert.equal(await readFile(path.join(b.root, "handoff.txt"), "utf8"), "handed over\n", "synced only once the file is there");
    assert.equal(arrived.eligible, true, JSON.stringify(arrived));
    await converged([a, b], projectId, ([, treeB]) => treeB.has("handoff.txt"));
    assert.deepEqual(sides.map((side) => side.syncthing.added(logMark.get(side))), [[], []], "no Syncthing folder came back while on built-in sync");

    // 7. Moving back: the engine stops writing the project on both nodes, and enrollment gives Syncthing its folders again.
    const rolledBack = await switchEngine(a, projectId, "syncthing");
    assert.equal(rolledBack.status, 200, JSON.stringify(rolledBack.body));
    const restored = await watchPhases([a, b], projectId, (projects) => projects.every((entry) => entry?.phase === "syncthing" && entry.engine === "syncthing"), SYNC_TIMEOUT_MS);
    assert.deepEqual(restored.last.map((entry) => [entry?.phase, entry?.engine]), [["syncthing", "syncthing"], ["syncthing", "syncthing"]], `${JSON.stringify(restored)}\n${lines(sides)}`);
    for (const side of [a, b]) {
      await until(async () => projectFolders(side, projectId), (folders) => folders.length === 3, 60_000, 500);
      assert.deepEqual(projectFolders(side, projectId).map((folder) => folder.id).sort(), ownFolders.get(side), `${side.label}'s Syncthing has the project's folders again`);
    }
    const beforeEdit = synced(b.root);
    const aBefore = shareOf(await status(a), projectId)!.maxSeq;
    await writeFile(path.join(a.root, "after-rollback.txt"), "written after the move back\n");
    await writeFile(path.join(a.root, "README.md"), "# Cutover nodes, edited after the move back\n");
    // B's engine pulls A's index with both changes (it keeps comparing in shadow mode), and still writes nothing.
    const [, seenOnB] = await until(() => Promise.all([status(a), status(b)]), ([answerA, answerB]) => {
      const max = shareOf(answerA, projectId)?.maxSeq ?? 0, peer = peerOf(answerB, projectId, a.node.nodeId);
      return max >= aBefore + 2 && peer?.caughtUp === true && peer.cursor >= max;
    }, 30_000);
    assert.equal(peerOf(seenOnB, projectId, a.node.nodeId)?.caughtUp, true, `B's engine has seen A's change: ${describe(seenOnB, projectId)}`);
    await pause(3_000);
    assert.equal(existsSync(path.join(b.root, "after-rollback.txt")), false, "back on Syncthing, the engine wrote nothing new on B");
    assert.deepEqual([...synced(b.root)], [...beforeEdit], "B's tree is as it was");

    // 8. Moving to built-in sync again, with B stopped while releasing and again while bootstrapping.
    await writeFiles(b.root, { "after-rollback.txt": "written after the move back\n", "README.md": "# Cutover nodes, edited after the move back\n" });
    const againReady = await until(() => checks(a, projectId), (answer) => !failing(answer).length, 90_000, 500);
    assert.deepEqual(failing(againReady), [], checkText(againReady));
    b.syncthing.hold = true;
    const second = await switchEngine(a, projectId, "builtin");
    assert.equal(second.status, 200, JSON.stringify(second.body));
    const held = await watchPhases([a, b], projectId, (projects) => projects[0]?.phase === "builtin" && projects[1]?.phase === "releasing" && /let go/.test(projects[1]?.phaseMessage ?? ""), SYNC_TIMEOUT_MS);
    assert.deepEqual(held.last.map((entry) => entry?.phase), ["builtin", "releasing"], `${JSON.stringify(held.last)}\n${lines(sides)}`);
    // A writes while B is still on its way: nothing reaches B's tree before B takes over.
    await writeFile(path.join(a.root, "while-b-moves.txt"), "written while B releases\n");
    await rm(path.join(a.root, "keep", "deep", "file.txt"));
    await pause(4_000);
    assert.equal(existsSync(path.join(b.root, "while-b-moves.txt")), false, "B's engine does not write before its own phase is builtin");
    assert.equal(existsSync(path.join(b.root, "keep", "deep", "file.txt")), true);

    // Stopped while releasing: back up, it is still releasing and asks its Syncthing again.
    const removesBefore = b.syncthing.log.filter((entry) => entry.startsWith("remove ")).length;
    await restart(b);
    const resumed = await until(() => project(b, projectId), (entry) => entry?.phase === "releasing" && b.syncthing.log.filter((line) => line.startsWith("remove ")).length > removesBefore, 60_000, 300);
    assert.equal(resumed?.phase, "releasing", `${JSON.stringify(resumed)}\n${lines([b])}`);
    assert.ok(b.syncthing.log.filter((entry) => entry.startsWith("remove ")).length > removesBefore, "the resumed release asked Syncthing again");

    // Syncthing lets go, but B cannot read its project folder: the bootstrap waits; B is stopped there.
    await chmod(b.root, 0o000);
    try {
      b.syncthing.hold = false;
      const bootstrapping = await until(() => project(b, projectId), (entry) => entry?.phase === "bootstrapping" && /could not read/.test(entry.phaseMessage ?? ""), 90_000, 300);
      assert.equal(bootstrapping?.phase, "bootstrapping", `${JSON.stringify(bootstrapping)}\n${lines([b])}`);
      assert.deepEqual(projectFolders(b, projectId), [], "B's Syncthing let go before the bootstrap");
      await stopDevNode(b.child!);
      b.child = undefined;
    } finally { await chmod(b.root, 0o755); }
    await restart(b);
    const finished = await watchPhases([b], projectId, (projects) => projects[0]?.phase === "builtin", SYNC_TIMEOUT_MS);
    assert.equal(finished.last[0]?.phase, "builtin", `${JSON.stringify(finished)}\n${lines([b])}`);
    assert.ok(inOrder(finished.seen[0]), finished.seen[0].join(" → "));
    // What A wrote and deleted as built-in sync reached B, the deletion into B's trash.
    await converged([a, b], projectId, ([, treeB]) => treeB.has("while-b-moves.txt") && !treeB.has("keep/deep/file.txt"));
    assert.ok(inTrash(b.node, "keep/deep/file.txt", "deep\n"), `B keeps the file A deleted: ${JSON.stringify(trashed(b.node))}`);
    for (const side of [a, b]) {
      assert.deepEqual(projectFolders(side, projectId), [], `${side.label}: Syncthing holds none of the project's folders`);
      assert.ok(side.syncthing.folders.has("user-photos"));
      assert.equal(side.syncthing.folders.get("joint-bob-ticket-workspaces")?.paused, true);
      assert.ok(!side.syncthing.log.some((entry) => /^(remove|update) (user-photos|joint-bob-ticket-workspaces)$/.test(entry)), `${side.label} never touched a folder not the project's: ${JSON.stringify(side.syncthing.log)}`);
    }
    // And B's own changes go out again.
    await writeFile(path.join(b.root, "from-b.txt"), "after the restarts\n");
    await converged([a, b], projectId, ([treeA]) => treeA.has("from-b.txt"));
    // B's restarts never read as "file sync is off there", which would have had A move the project back on its own.
    assert.deepEqual(a.lines.filter((line) => /moved .* back to Syncthing/.test(line)), [], "the owner never moved the project back by itself");
    assert.equal((await project(a, projectId))?.engine, "builtin");
    if (sides.some((side) => side.lines.length)) t.diagnostic(`log lines: ${lines(sides).split("\n").slice(-20).join(" | ")}`);
  } finally {
    for (const side of sides) if (side.root && existsSync(side.root)) await chmod(side.root, 0o755).catch(() => undefined);
    await Promise.all(sides.map((side) => side.child ? stopDevNode(side.child) : undefined));
    await Promise.all(sides.map((side) => side.syncthing.close()));
    await rm(root, { recursive: true, force: true });
  }
}

test("the owner moves a project to built-in sync and back: every file kept, Syncthing lets go of only its folders, restarts resume", { timeout: 900_000 }, (t) => runCutover(t));

/* ---- auto-transition: Matan's case. A (the owner) and B run the new release; C has file sync off.
   Nobody presses anything: the project stays on Syncthing everywhere while C cannot take part,
   C turns file sync on and compares in shadow, the files match for cleanHours (seconds here), A
   moves the project by itself and B and C follow. C then goes away and comes back with file sync
   off: A moves the project back by itself, B follows at once and C when it returns, and A moves it
   again only after a fresh matching time. ---- */

const CLEAN_SECONDS = 20;
const C_NAME = "Matans-Sela-MacBook-Pro";

async function eventually(read: () => Promise<boolean>, what: string, timeoutMs: number, sides: Side[]): Promise<void> {
  const ok = await until(read, Boolean, timeoutMs, 500);
  assert.ok(ok, `${what}\n${lines(sides)}`);
}

async function pairTwins(inviter: Side, acceptor: Side): Promise<void> {
  const invitation = await api<{ link: string }>(inviter.node, inviter.session, "POST", "/twins/invitations", { confirmOwnedData: true });
  assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
  const accepted = await api(acceptor.node, acceptor.session, "POST", "/twins/accept", { link: invitation.body.link, confirmOwnedData: true });
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
}

async function runMatanCase(t: TestContext): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "file-sync-auto-")));
  const sides: Side[] = [];
  try {
    const envs = await Promise.all(["a", "b", "c"].map((label) => seedDevEnvironment(path.join(root, label), 1)));
    const make = async (label: string, env: DevEnvironment, device: string): Promise<Side> => {
      const syncthing = new FakeSyncthing(device);
      await syncthing.start();
      const ticketRoot = path.join(root, `${label.toLowerCase()}-tickets`), worktreeRoot = path.join(root, `${label.toLowerCase()}-worktrees`);
      await mkdir(ticketRoot, { recursive: true });
      syncthing.add({ id: "user-photos", label: "Photos", path: path.join(root, `${label.toLowerCase()}-photos`) });
      const port = await freePort();
      return {
        label, env, node: env.nodes[0], session: undefined as unknown as SignedIn, root: "", ticketRoot, worktreeRoot, syncthing, lines: [],
        extraEnv: {
          JOINT_BOB_FILE_SYNC_SETTLE_MS: "3000", JOINT_BOB_FILE_SYNC_PORT: String(port), JOINT_BOB_FILE_SYNC_LISTEN: "127.0.0.1",
          JOINT_BOB_SYNCTHING_URL: syncthing.url, JOINT_BOB_SYNCTHING_API_KEY: "test-key", JOINT_BOB_TICKET_ROOT: ticketRoot, JOINT_BOB_WORKTREE_ROOT: worktreeRoot,
        },
      };
    };
    const device = (letter: string) => Array.from({ length: 8 }, () => letter.repeat(7)).join("-");
    const [a, b, c] = await Promise.all([make("A", envs[0], device("A")), make("B", envs[1], device("B")), make("C", envs[2], device("C"))]);
    sides.push(a, b, c);
    await Promise.all(sides.map(startSide));
    // Every seeded node has the same name; the reasons name machines, so each gets its own (C is someone else's Mac).
    for (const [side, name] of [[a, "Ilia-MacBook-Pro"], [b, "homeserver"], [c, C_NAME]] as const) {
      assert.equal((await api(side.node, side.session, "PUT", "/cluster/node", { name, url: side.node.url })).status, 200);
      side.node.name = name;
    }
    await pairTwins(a, b);
    await pairTwins(a, c);

    a.root = path.join(root, "project");
    const base = { "README.md": "# Auto transition\n", "src/index.ts": "export const answer = 41;\n", "notes.txt": "notes\n" };
    await writeFiles(a.root, base);
    const created = await api<{ project: { id: string } }>(a.node, a.session, "POST", "/projects", { name: "Dak-Live", type: "personal", path: a.root, synced: true });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const projectId = created.body.project.id;
    for (const side of [b, c]) {
      const listed = await until(() => api<{ projects: Array<{ id: string; path: string }> }>(side.node, side.session, "GET", "/projects?syncStatus=false"),
        (answer) => answer.body.projects?.some((candidate) => candidate.id === projectId) ?? false, 30_000);
      side.root = listed.body.projects?.find((candidate) => candidate.id === projectId)?.path ?? "";
      assert.ok(side.root && side.root !== a.root, `${side.label} lists the project with its own folder`);
      // Syncthing's part: the same files there.
      await writeFiles(side.root, base);
    }
    // A and B run the new release with file sync on; the matching time is seconds instead of a day. C keeps file sync off.
    for (const side of [a, b]) {
      const configured = await api<FileSyncStatusAnswer>(side.node, side.session, "PUT", "/file-sync/config", { enabled: true, shadowProjects: [projectId], autoSwitch: { cleanHours: CLEAN_SECONDS / 3600 } });
      assert.equal(configured.status, 200, JSON.stringify(configured.body));
      await until(() => status(side), (answer) => answer.worker === "running", 30_000);
    }
    for (const side of sides) {
      await until(async () => projectFolders(side, projectId), (folders) => folders.length === 3, 60_000, 500);
      assert.equal(projectFolders(side, projectId).length, 3, `${side.label}'s Syncthing holds the project's folders`);
    }

    // 1. C cannot take part: the project stays on Syncthing everywhere, and A says why, naming C. B (not the owner) shows it too.
    const waiting = await until(() => project(a, projectId), (entry) => entry?.autoSwitch?.reason === `Waiting for ${C_NAME} to turn on file sync`, 60_000, 500);
    assert.equal(waiting?.autoSwitch?.reason, `Waiting for ${C_NAME} to turn on file sync`, `${JSON.stringify(waiting)}\n${lines(sides)}`);
    const onB = await until(() => project(b, projectId), (entry) => entry?.autoSwitch?.reason === `Waiting for ${C_NAME} to turn on file sync`, 30_000, 500);
    assert.equal(onB?.autoSwitch?.reason, `Waiting for ${C_NAME} to turn on file sync`, `B shows the owner's reason: ${JSON.stringify(onB)}`);
    assert.equal(onB?.autoSwitch?.decidedBy, a.node.name);
    await pause((CLEAN_SECONDS + 10) * 1000);
    for (const side of sides) assert.deepEqual([(await project(side, projectId))?.engine, (await project(side, projectId))?.phase], ["syncthing", "syncthing"], `${side.label}: still on Syncthing while C cannot take part`);
    assert.deepEqual(sides.map((side) => projectFolders(side, projectId).length), [3, 3, 3], "every Syncthing still holds the project");

    // 2. C turns file sync on (the stored default list is "all"; here only this project): it indexes in shadow, the files match for
    //    the matching time, and A moves the project by itself; B and C follow. Nobody calls the move.
    const turnedOnAt = Date.now();
    const onC = await api<FileSyncStatusAnswer>(c.node, c.session, "PUT", "/file-sync/config", { enabled: true, shadowProjects: [projectId], autoSwitch: { cleanHours: CLEAN_SECONDS / 3600 } });
    assert.equal(onC.status, 200, JSON.stringify(onC.body));
    const moved = await watchPhases(sides, projectId, (entries) => entries.every((entry) => entry?.phase === "builtin" && entry.engine === "builtin"), SYNC_TIMEOUT_MS + CLEAN_SECONDS * 1000);
    assert.deepEqual(moved.last.map((entry) => [entry?.engine, entry?.phase]), [["builtin", "builtin"], ["builtin", "builtin"], ["builtin", "builtin"]], `${JSON.stringify(moved)}\n${lines(sides)}`);
    for (const [index, phases] of moved.seen.entries()) assert.ok(inOrder(phases), `${sides[index].label} walked the phases in order: ${phases.join(" → ")}`);
    t.diagnostic(`moved ${Math.round((Date.now() - turnedOnAt) / 1000)} s after C turned file sync on; phases: ${moved.seen.map((phases, index) => `${sides[index].label} ${phases.join(" → ")}`).join("; ")}`);
    assert.ok(Date.now() - turnedOnAt >= CLEAN_SECONDS * 1000, "not before the files matched for the matching time");
    assert.ok(a.lines.some((line) => /moved Dak-Live to built-in sync by itself/.test(line)), `A logged its own move:\n${lines([a])}`);
    for (const side of sides) assert.deepEqual(projectFolders(side, projectId), [], `${side.label}: Syncthing let go of the project`);
    // Files travel with the engine now: C's edit reaches A and B (B through A).
    await writeFile(path.join(c.root, "from-c.txt"), "written on C\n");
    await eventually(async () => existsSync(path.join(a.root, "from-c.txt")) && existsSync(path.join(b.root, "from-c.txt")), "C's file reached A and B", SYNC_TIMEOUT_MS, sides);
    assert.equal(await readFile(path.join(b.root, "from-c.txt"), "utf8"), "written on C\n");

    // 3. C goes away and comes back with file sync off (forced by its environment): A moves the project back by itself; B follows at
    //    once; C, away and then off, follows when it runs file sync again. The move back starts the matching time over.
    await stopDevNode(c.child!);
    c.child = undefined;
    c.extraEnv = { ...c.extraEnv, JOINT_BOB_FILE_SYNC: "0" };
    const offAt = Date.now();
    await startSide(c);
    const back = await watchPhases([a, b], projectId, (entries) => entries.every((entry) => entry?.engine === "syncthing" && entry.phase === "syncthing"), SYNC_TIMEOUT_MS);
    assert.deepEqual(back.last.map((entry) => [entry?.engine, entry?.phase]), [["syncthing", "syncthing"], ["syncthing", "syncthing"]], `${JSON.stringify(back)}\n${lines(sides)}`);
    assert.ok(a.lines.some((line) => /moved Dak-Live back to Syncthing: .*(file sync turned off|turning file sync off)/.test(line)), `A logged why:\n${lines([a])}`);
    // fix: C, off, still follows: its engine runs until the project is back on Syncthing there, Syncthing gets the folders
    //    back, and only then the engine stops.
    const leftC = await watchPhases([c], projectId, (entries) => entries[0]?.engine === "syncthing" && entries[0]?.phase === "syncthing", SYNC_TIMEOUT_MS);
    assert.deepEqual([leftC.last[0]?.engine, leftC.last[0]?.phase], ["syncthing", "syncthing"], `${JSON.stringify(leftC)}\n${lines([c])}`);
    const stoppedC = await until(() => status(c), (answer) => answer.worker === "off" && !answer.leaving, 30_000, 500);
    assert.deepEqual([stoppedC.worker, stoppedC.leaving], ["off", false], `C's engine stopped once it held nothing: ${JSON.stringify(stoppedC)}\n${lines([c])}`);
    await until(async () => projectFolders(c, projectId), (folders) => folders.length === 3, 60_000, 500);
    assert.equal(projectFolders(c, projectId).length, 3, `C's Syncthing has the project's folders again\n${lines([c])}`);
    // C comes back with file sync on: it learns of the move back and follows; nobody pressed anything there either.
    await stopDevNode(c.child!);
    c.child = undefined;
    const { JOINT_BOB_FILE_SYNC: _off, ...withoutOverride } = c.extraEnv;
    c.extraEnv = withoutOverride;
    await startSide(c);
    const followed = await watchPhases([c], projectId, (entries) => entries[0]?.engine === "syncthing" && entries[0]?.phase === "syncthing", SYNC_TIMEOUT_MS);
    assert.deepEqual([followed.last[0]?.engine, followed.last[0]?.phase], ["syncthing", "syncthing"], `${JSON.stringify(followed)}\n${lines([c])}`);
    const backAt = Date.now();
    // Every machine runs file sync again: A moves the project once more by itself, a fresh matching time after the move back.
    const again = await watchPhases(sides, projectId, (entries) => entries.every((entry) => entry?.phase === "builtin" && entry.engine === "builtin"), SYNC_TIMEOUT_MS + CLEAN_SECONDS * 1000);
    assert.deepEqual(again.last.map((entry) => entry?.phase), ["builtin", "builtin", "builtin"], `${JSON.stringify(again.last)}\n${lines(sides)}`);
    assert.ok(Date.now() - offAt >= CLEAN_SECONDS * 1000, "the move back started the matching time over");
    t.diagnostic(`C followed the move back ${Math.round((backAt - offAt) / 1000)} s after it went away; moved again ${Math.round((Date.now() - backAt) / 1000)} s later`);
  } finally {
    await Promise.all(sides.map((side) => side.child ? stopDevNode(side.child) : undefined));
    await Promise.all(sides.map((side) => side.syncthing.close()));
    await rm(root, { recursive: true, force: true });
  }
}

test("Matan's case: a project shared with three machines moves to built-in sync by itself once every one can take it, and back and forth without anyone pressing anything", { timeout: 900_000 }, (t) => runMatanCase(t));
