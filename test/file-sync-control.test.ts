import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pinClusterPublicKey } from "../src/cluster-identity.js";
import { ensurePeerEndpointSchema, recordPeerEndpoint } from "../src/cluster-peer-endpoints.js";
import { ensureResourceSharingSchema } from "../src/cluster-sharing.js";
import { addSharingMember, createSharingCluster, getSharingCluster, recordRelaySharingHeartbeat, registerOwnedResource, setResourceShares } from "../src/cluster-sharing-policy.js";
import { ensureControlSchema, ensureRevisionTriggers, readFileSyncConfig, readRevision, saveSettingsRecord, writeFileSyncConfig } from "../src/file-sync/control.js";
import type { ShareStatus } from "../src/file-sync/protocol.js";
import { deriveShares, droppedShares, fileSyncHostId, shareContaining, type DeriveInput } from "../src/file-sync/shares.js";
import { projectSyncStatus } from "../src/file-sync/status.js";
import { EMPTY_RULE_SETTINGS, type Phase, type RuleSettings } from "../src/file-sync/types.js";

const LOCAL = "00000000-0000-4000-8000-000000000001";
const PEER = "00000000-0000-4000-8000-000000000002";
const OUTSIDER = "00000000-0000-4000-8000-000000000003";
const KEYLESS = "00000000-0000-4000-8000-000000000004";
const CLUSTER = "10000000-0000-4000-8000-000000000001";
const OTHER_CLUSTER = "10000000-0000-4000-8000-000000000002";
const NOW = "2026-10-25T00:00:00.000Z";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  ensureResourceSharingSchema(db);
  ensurePeerEndpointSchema(db);
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT 'personal', color TEXT,
    path TEXT NOT NULL UNIQUE, mac_path TEXT, sync_folder_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  ensureControlSchema(db);
  return db;
}

function addProject(db: DatabaseSync, id: string, root: string, options: { owner?: string; deleted?: boolean; registered?: boolean } = {}): void {
  const owner = options.owner ?? LOCAL;
  db.prepare("INSERT INTO projects (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, id, root, NOW, NOW);
  if (options.registered !== false) registerOwnedResource(db, { kind: "project", id, ownerNodeId: owner }, LOCAL);
  db.prepare("INSERT INTO cluster_v2_resource_policy VALUES ('project', ?, ?, 1, ?)").run(id, owner, options.deleted ? 1 : 0);
}

function addPeer(db: DatabaseSync, clusterId: string, nodeId: string, options: { key?: boolean } = {}): void {
  if (!db.prepare("SELECT 1 FROM sharing_clusters WHERE id = ?").get(clusterId)) createSharingCluster(db, { id: clusterId, name: clusterId.slice(-4) }, LOCAL);
  addSharingMember(db, clusterId, LOCAL, nodeId, getSharingCluster(db, clusterId).managerEpoch);
  recordPeerEndpoint(db, { kind: "cluster", id: clusterId }, { nodeId, name: `node ${nodeId.slice(-1)}`, url: `https://${nodeId.slice(-4)}.example.com` });
  if (options.key !== false) pinClusterPublicKey(db, nodeId, generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString());
}

/** LOCAL owns "alpha", shared in CLUSTER with PEER; OUTSIDER is in another cluster that does not have it. */
function sharedFixture(): DatabaseSync {
  const db = database();
  addPeer(db, CLUSTER, PEER);
  addPeer(db, OTHER_CLUSTER, OUTSIDER);
  addProject(db, "alpha", "/projects/alpha");
  setResourceShares(db, LOCAL, "project", "alpha", [{ clusterId: CLUSTER, projectId: null }]);
  return db;
}

function input(overrides: Partial<DeriveInput> = {}): DeriveInput {
  return { local: LOCAL, shadowProjects: "all", phases: new Map(), settings: new Map(), ticketRoot: "/home/tickets", worktreeRoot: (id) => `/home/worktrees/${id}`, ...overrides };
}

const revision = (db: DatabaseSync): number => readRevision(db).revision;

test("file sync is off with an empty shadow list and the default port until configured", () => {
  const db = database();
  assert.deepEqual(readFileSyncConfig(db, {}), { enabled: false, enabledBy: "default", shadowProjects: [], port: 22700 });
});

test("JOINT_BOB_FILE_SYNC overrides the stored switch both ways", () => {
  const db = database();
  writeFileSyncConfig(db, { enabled: false }, {});
  assert.deepEqual([readFileSyncConfig(db, { JOINT_BOB_FILE_SYNC: "1" }).enabled, readFileSyncConfig(db, { JOINT_BOB_FILE_SYNC: "1" }).enabledBy], [true, "environment"]);
  writeFileSyncConfig(db, { enabled: true }, {});
  assert.equal(readFileSyncConfig(db, { JOINT_BOB_FILE_SYNC: "0" }).enabled, false);
  assert.deepEqual([readFileSyncConfig(db, {}).enabled, readFileSyncConfig(db, {}).enabledBy], [true, "settings"]);
  assert.equal(readFileSyncConfig(db, { JOINT_BOB_FILE_SYNC: "yes" }).enabledBy, "settings", "only 0 and 1 override");
});

test("under a test runner file sync is off unless a test turns it on", () => {
  const db = database();
  assert.equal(readFileSyncConfig(db, { NODE_TEST_CONTEXT: "child-v8" }).enabled, false);
  assert.equal(readFileSyncConfig(db, { NODE_ENV: "test" }).enabled, false);
  assert.equal(readFileSyncConfig(db, { NODE_ENV: "test", JOINT_BOB_FILE_SYNC: "1" }).enabled, true);
});

test("the shadow list is stored sorted without duplicates, and an invalid patch changes nothing", () => {
  const db = database();
  assert.deepEqual(writeFileSyncConfig(db, { shadowProjects: ["beta", "alpha", "beta"] }, {}).shadowProjects, ["alpha", "beta"]);
  assert.equal(writeFileSyncConfig(db, { shadowProjects: "all" }, {}).shadowProjects, "all");
  assert.throws(() => writeFileSyncConfig(db, { port: 0 }, {}));
  assert.throws(() => writeFileSyncConfig(db, { enabled: true, extra: 1 } as never, {}));
  assert.deepEqual(readFileSyncConfig(db, {}), { enabled: false, enabledBy: "default", shadowProjects: "all", port: 22700 });
  assert.equal(readFileSyncConfig(db, { JOINT_BOB_FILE_SYNC_PORT: "22705" }).port, 22705);
});

test("a change to a project's root or sharing bumps the revision; touching the project does not", () => {
  const db = sharedFixture();
  assert.ok(ensureRevisionTriggers(db) > 0);
  let before = revision(db);
  db.prepare("UPDATE projects SET updated_at = ? WHERE id = 'alpha'").run("2026-10-25T01:00:00.000Z");
  assert.equal(revision(db), before, "updated_at is rewritten on every sessions request");
  db.prepare("UPDATE projects SET path = '/projects/alpha-moved' WHERE id = 'alpha'").run();
  assert.equal(revision(db), before + 1, "a moved root");
  before = revision(db);
  db.prepare("UPDATE cluster_v2_resource_policy SET deleted = 1 WHERE resource_id = 'alpha'").run();
  assert.equal(revision(db), before + 1, "a deleted policy");
  before = revision(db);
  setResourceShares(db, LOCAL, "project", "alpha", []);
  assert.ok(revision(db) > before, "an unshared project");
  before = revision(db);
  addProject(db, "beta", "/projects/beta");
  assert.ok(revision(db) > before, "a new project");
});

test("a relay lease bumps the revision when it starts or ends, not when it is renewed", () => {
  const db = sharedFixture();
  ensureRevisionTriggers(db);
  let before = revision(db);
  recordRelaySharingHeartbeat(db, OUTSIDER, true);
  assert.equal(revision(db), before + 1, "lease taken");
  before = revision(db);
  recordRelaySharingHeartbeat(db, OUTSIDER, true);
  assert.equal(revision(db), before, "lease renewed");
  recordRelaySharingHeartbeat(db, OUTSIDER, false);
  assert.equal(revision(db), before + 1, "lease dropped");
});

test("saving the same config again does not bump the revision", () => {
  const db = database();
  ensureRevisionTriggers(db);
  writeFileSyncConfig(db, { shadowProjects: ["alpha"] }, {});
  const before = revision(db);
  writeFileSyncConfig(db, { shadowProjects: ["alpha"] }, {});
  assert.equal(revision(db), before);
  writeFileSyncConfig(db, { shadowProjects: ["alpha", "beta"] }, {});
  assert.equal(revision(db), before + 1);
});

test("triggers lost to a table rebuild come back on the next pass, which sees the schema move", () => {
  const db = sharedFixture();
  ensureRevisionTriggers(db);
  const { schema } = readRevision(db);
  db.exec(`ALTER TABLE projects RENAME TO projects_old;
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT 'personal', color TEXT,
      path TEXT NOT NULL UNIQUE, mac_path TEXT, sync_folder_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO projects SELECT * FROM projects_old; DROP TABLE projects_old;`);
  assert.notEqual(readRevision(db).schema, schema);
  const before = revision(db);
  db.prepare("UPDATE projects SET path = '/elsewhere' WHERE id = 'alpha'").run();
  assert.equal(revision(db), before, "the rebuilt table has no trigger yet");
  assert.equal(ensureRevisionTriggers(db), 3);
  db.prepare("UPDATE projects SET path = '/elsewhere-again' WHERE id = 'alpha'").run();
  assert.equal(revision(db), before + 1);
  assert.equal(ensureRevisionTriggers(db), 0, "nothing missing any more");
});

test("a watched table created later gets its triggers on the next pass", () => {
  const db = database();
  ensureRevisionTriggers(db);
  db.exec("CREATE TABLE project_locations (project_id TEXT NOT NULL, node_id TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY (project_id, node_id))");
  assert.equal(ensureRevisionTriggers(db), 3);
  const before = revision(db);
  db.prepare("INSERT INTO project_locations VALUES ('alpha', ?, '/there')").run(PEER);
  assert.equal(revision(db), before + 1);
});

test("a shared project gets a project, a tickets and a worktrees share at their roots, with its eligible peer", () => {
  const shares = deriveShares(sharedFixture(), input());
  assert.deepEqual(shares.map(({ key, kind, root, phase, peers }) => ({ key, kind, root, phase, peers })), [
    { key: "project:alpha", kind: "project", root: "/projects/alpha", phase: "syncthing", peers: [PEER] },
    { key: "tickets:alpha", kind: "tickets", root: path.join("/home/tickets", "alpha"), phase: "syncthing", peers: [PEER] },
    { key: "worktrees:alpha", kind: "worktrees", root: "/home/worktrees/alpha", phase: "syncthing", peers: [PEER] },
  ]);
});

test("ticket and worktree roots default to the node's ticket and worktree folders", (t) => {
  const saved = { tickets: process.env.JOINT_BOB_TICKET_ROOT, worktrees: process.env.JOINT_BOB_WORKTREE_ROOT };
  t.after(() => {
    for (const [name, value] of [["JOINT_BOB_TICKET_ROOT", saved.tickets], ["JOINT_BOB_WORKTREE_ROOT", saved.worktrees]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  process.env.JOINT_BOB_TICKET_ROOT = "/data/tickets";
  process.env.JOINT_BOB_WORKTREE_ROOT = "/data/worktrees";
  const shares = deriveShares(sharedFixture(), input({ ticketRoot: undefined, worktreeRoot: undefined }));
  assert.deepEqual(shares.map((share) => share.root), ["/projects/alpha", "/data/tickets/alpha", "/data/worktrees/alpha"]);
});

test("a peer is listed only if it may receive the project and its key is pinned", () => {
  const db = sharedFixture();
  addPeer(db, CLUSTER, KEYLESS, { key: false });
  const shares = deriveShares(db, input());
  assert.deepEqual([...new Set(shares.flatMap((share) => share.peers))], [PEER], `peers: ${JSON.stringify(shares.map((share) => share.peers))}`);
});

test("a project without an eligible peer is not shared", () => {
  const db = sharedFixture();
  addProject(db, "solo", "/projects/solo");
  assert.deepEqual([...new Set(deriveShares(db, input()).map((share) => share.projectId))], ["alpha"]);
});

test("only projects in the shadow list are shared, unless their phase has left Syncthing", () => {
  const db = sharedFixture();
  addProject(db, "beta", "/projects/beta");
  setResourceShares(db, LOCAL, "project", "beta", [{ clusterId: CLUSTER, projectId: null }]);
  const projects = (overrides: Partial<DeriveInput>) => [...new Set(deriveShares(db, input(overrides)).map((share) => share.projectId))];
  assert.deepEqual(projects({ shadowProjects: [] }), []);
  assert.deepEqual(projects({ shadowProjects: ["beta"] }), ["beta"]);
  assert.deepEqual(projects({ shadowProjects: "all" }), ["alpha", "beta"]);
  assert.deepEqual(projects({ shadowProjects: [], phases: new Map<string, Phase>([["alpha", "builtin"], ["beta", "syncthing"]]) }), ["alpha"]);
  assert.equal(deriveShares(db, input({ shadowProjects: [], phases: new Map<string, Phase>([["alpha", "builtin"]]) }))[0].phase, "builtin");
});

test("a project whose policy is deleted is not shared", () => {
  const db = sharedFixture();
  addProject(db, "gone", "/projects/gone", { deleted: true });
  setResourceShares(db, LOCAL, "project", "gone", [{ clusterId: CLUSTER, projectId: null }]);
  assert.deepEqual([...new Set(deriveShares(db, input()).map((share) => share.projectId))], ["alpha"]);
});

test("a project shared with this node is not synced before its metadata is visible here", () => {
  const db = sharedFixture();
  // The peer owns it and shares it with the cluster, but no metadata receipt reached this node yet:
  // the policy arrives before the record.
  addProject(db, "replica", "/projects/replica", { owner: PEER });
  setResourceShares(db, PEER, "project", "replica", [{ clusterId: CLUSTER, projectId: null }]);
  assert.deepEqual([...new Set(deriveShares(db, input()).map((share) => share.projectId))], ["alpha"]);
});

test("a sharing check that throws counts as not shared without hiding other projects", () => {
  const db = sharedFixture();
  // A policy without an owner row makes mayShareProject throw "Unknown project resource".
  addProject(db, "orphan", "/projects/orphan", { registered: false });
  assert.deepEqual([...new Set(deriveShares(db, input()).map((share) => share.projectId))], ["alpha"]);
});

test("index state is dropped for a deleted policy or a removed project, never for a share that is merely not derived", () => {
  const db = sharedFixture();
  addProject(db, "gone", "/projects/gone", { deleted: true });
  addProject(db, "solo", "/projects/solo");
  assert.deepEqual(droppedShares(db, ["project:alpha", "tickets:solo", "worktrees:removed", "not a share key"]),
    ["project:gone", "tickets:gone", "worktrees:gone", "worktrees:removed"]);
});

test("a share's rules are its project's record over its owner's global record", () => {
  const db = sharedFixture();
  const settings = new Map<string, RuleSettings>([
    ["project:alpha", { ...EMPTY_RULE_SETTINGS, userRules: ["*.wav"], gitignore: true }],
    [`global:${LOCAL}`, { ...EMPTY_RULE_SETTINGS, userRules: ["*.mp3", "*.wav"] }],
    [`global:${PEER}`, { ...EMPTY_RULE_SETTINGS, userRules: ["*.peer-only"] }],
  ]);
  const project = deriveShares(db, input({ settings })).find((share) => share.key === "project:alpha")!;
  assert.deepEqual(project.rules, { disabledBuiltins: [], userRules: ["*.wav", "*.mp3"], removedUserRules: [], gitignore: true, importedFrom: [] });
});

test("settings records keep the newer write", () => {
  const db = database();
  assert.equal(saveSettingsRecord(db, { key: "project:alpha", value: { ...EMPTY_RULE_SETTINGS, userRules: ["a"] }, updatedAt: "2026-10-25T02:00:00.000Z", origin: PEER }), true);
  assert.equal(saveSettingsRecord(db, { key: "project:alpha", value: { ...EMPTY_RULE_SETTINGS, userRules: ["b"] }, updatedAt: "2026-10-25T01:00:00.000Z", origin: LOCAL }), false);
});

test("a path belongs to the deepest share root that contains it", () => {
  const shares = deriveShares(sharedFixture(), input({ worktreeRoot: (id) => `/projects/alpha/.worktrees/${id}` }));
  assert.deepEqual(shareContaining(shares, "/projects/alpha/.worktrees/alpha/1234/src"), { share: shares[2], subtree: "1234/src" });
  assert.deepEqual(shareContaining(shares, "/projects/alpha"), { share: shares[0] });
  assert.equal(shareContaining(shares, "/projects/alphabet"), undefined);
});

test("the host id is created once per machine and kept", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "jb-file-sync-host-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const first = fileSyncHostId(home);
  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.equal(fileSyncHostId(home), first);
  assert.equal((await readFile(path.join(home, ".joint-bob-host-id"), "utf8")).trim(), first);
  await writeFile(path.join(home, ".joint-bob-host-id"), "not a usable id\n");
  const replaced = fileSyncHostId(home);
  assert.notEqual(replaced, first);
  assert.equal(fileSyncHostId(home), replaced);
});

function share(overrides: Partial<ShareStatus>): ShareStatus {
  return {
    share: "project:alpha", projectId: "alpha", kind: "project", state: "idle", phase: "builtin", maxSeq: 1, indexId: "i", digest: "d", rulesHash: "r",
    liveFiles: 1, liveBytes: 1, need: { files: 0, bytes: 0 }, blocked: 0, errors: 0, held: 0, scanning: false, watch: "watching", peers: [], ...overrides,
  };
}

test("a project's status says error before unavailable before syncing before synced", () => {
  const engine = { enabled: true, running: true };
  assert.equal(projectSyncStatus([share({})], { enabled: false, running: false }).state, "unavailable");
  assert.deepEqual(projectSyncStatus([share({ need: { files: 2, bytes: 10 } }), share({ held: 600 })], engine), { state: "error", remainingFiles: 2, remainingBytes: 10, message: "600 deletions on hold: confirm in Settings → File sync" });
  assert.equal(projectSyncStatus([share({ state: "unavailable" }), share({ need: { files: 1, bytes: 1 } })], engine).state, "unavailable");
  assert.deepEqual(projectSyncStatus([share({ need: { files: 1, bytes: 5 } })], engine), { state: "syncing", remainingFiles: 1, remainingBytes: 5, message: "1 file to receive" });
  assert.equal(projectSyncStatus([share({})], { enabled: true, running: false }).message, "Starting file sync");
  assert.deepEqual(projectSyncStatus([share({})], engine), { state: "synced", remainingFiles: 0, remainingBytes: 0, message: "Files are up to date" });
});

test("a peer that is away does not keep a project syncing", () => {
  const behind = share({ peers: [{ peer: PEER, cursor: 1, peerMaxSeq: 9, peerIndexId: "x", peerDigest: null, rulesMatch: true, caughtUp: false, differences: 0, cleanSince: null, route: "relay" }] });
  assert.equal(projectSyncStatus([behind], { enabled: true, running: true }).state, "syncing");
  assert.equal(projectSyncStatus([behind], { enabled: true, running: true, present: () => false }).state, "synced");
});
