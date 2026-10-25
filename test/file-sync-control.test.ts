import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getOrCreateClusterIdentity, pinClusterPublicKey } from "../src/cluster-identity.js";
import { ensurePeerEndpointSchema, recordPeerEndpoint } from "../src/cluster-peer-endpoints.js";
import { ensureResourceSharingSchema } from "../src/cluster-sharing.js";
import { addSharingMember, createSharingCluster, getSharingCluster, recordRelaySharingHeartbeat, registerOwnedResource, setResourceShares } from "../src/cluster-sharing-policy.js";
import { workerLaunch } from "../src/file-sync/bridge.js";
import { ensureControlSchema, ensureRevisionTriggers, fileSyncListenAddresses, readFileSyncConfig, readRevision, saveSettingsRecord, tailnetAddresses, writeFileSyncConfig } from "../src/file-sync/control.js";
import { acceptablePeerOrigin, forgetPeerFileSync, notePeerFileSync, onPeerFileSyncChanged, parseFileSyncPart, peerSpecs } from "../src/file-sync/peers.js";
import type { ConfigureArgs, ShareStatus } from "../src/file-sync/protocol.js";
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
  assert.deepEqual(readFileSyncConfig(db, {}), { enabled: false, enabledBy: "default", shadowProjects: [], shadowProjectsBy: "default", port: 22700 });
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
  assert.deepEqual(readFileSyncConfig(db, {}), { enabled: false, enabledBy: "default", shadowProjects: "all", shadowProjectsBy: "settings", port: 22700 });
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

test("turning multi-user mode on or off bumps the revision; other node settings do not", () => {
  const db = sharedFixture();
  db.exec("CREATE TABLE IF NOT EXISTS node_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, is_secret INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)");
  ensureRevisionTriggers(db);
  const put = (key: string, value: string) => db.prepare("INSERT INTO node_settings (key, value, is_secret, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(key, value, new Date().toISOString());
  let before = revision(db);
  put("theme", "dark");
  assert.equal(revision(db), before, "an unrelated setting");
  put("multiUser.enabled", "true");
  assert.equal(revision(db), before + 1, "turned on");
  before = revision(db);
  put("multiUser.enabled", "false");
  assert.equal(revision(db), before + 1, "turned off");
  before = revision(db);
  db.prepare("DELETE FROM node_settings WHERE key = 'multiUser.enabled'").run();
  assert.equal(revision(db), before + 1, "removed");
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
    liveFiles: 1, liveBytes: 1, need: { files: 0, bytes: 0 }, blocked: 0, errors: 0, scanning: false, watch: "watching", peers: [], ...overrides,
  };
}

test("a project's status says error before unavailable before syncing before synced", () => {
  const engine = { enabled: true, running: true };
  assert.equal(projectSyncStatus([share({})], { enabled: false, running: false }).state, "unavailable");
  assert.deepEqual(projectSyncStatus([share({ need: { files: 2, bytes: 10 } }), share({ blocked: 3 })], engine), { state: "error", remainingFiles: 2, remainingBytes: 10, message: "3 files could not be synchronized" });
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

test("JOINT_BOB_FILE_SYNC_PROJECTS overrides the stored shadow list, and an unusable value leaves it in charge", () => {
  const db = database();
  writeFileSyncConfig(db, { shadowProjects: ["alpha"] }, {});
  const read = (value: string) => { const config = readFileSyncConfig(db, { JOINT_BOB_FILE_SYNC_PROJECTS: value }); return [config.shadowProjects, config.shadowProjectsBy]; };
  assert.deepEqual(read("all"), ["all", "environment"]);
  assert.deepEqual(read(" gamma, beta ,gamma,"), [["beta", "gamma"], "environment"]);
  assert.deepEqual(read(""), [["alpha"], "settings"]);
  assert.deepEqual(read(" , "), [["alpha"], "settings"]);
  assert.deepEqual(read("x".repeat(301)), [["alpha"], "settings"], "a project id longer than any real one");
});

test("the direct listener binds tailnet addresses only, unless JOINT_BOB_FILE_SYNC_LISTEN says otherwise", () => {
  const entry = (address: string, family: "IPv4" | "IPv6" = "IPv4", internal = false) => ({ address, family, internal, netmask: "", mac: "", cidr: null, ...(family === "IPv6" ? { scopeid: 0 } : {}) }) as os.NetworkInterfaceInfo;
  const interfaces = {
    lo0: [entry("127.0.0.1", "IPv4", true)],
    en0: [entry("192.168.1.20"), entry("fe80::1", "IPv6")],
    utun4: [entry("100.101.2.3"), entry("fd7a:115c:a1e0::1", "IPv6")],
    utun5: [entry("100.64.0.9"), entry("100.128.0.1"), entry("100.63.255.255")],
  };
  assert.deepEqual(tailnetAddresses(interfaces), ["100.101.2.3", "100.64.0.9"], "100.64.0.0/10 and nothing around it");
  assert.deepEqual(fileSyncListenAddresses({}, interfaces), ["100.101.2.3", "100.64.0.9"]);
  assert.deepEqual(fileSyncListenAddresses({ JOINT_BOB_FILE_SYNC_LISTEN: "127.0.0.1, localhost,10.0.0.2,127.0.0.1" }, interfaces), ["10.0.0.2", "127.0.0.1"], "IPv4 literals only");
  assert.deepEqual(fileSyncListenAddresses({ JOINT_BOB_FILE_SYNC_LISTEN: "none" }, interfaces), []);
});

test("a peer's direct origins are used only on the tailnet, or on private networks the operator chose", () => {
  const listen = { JOINT_BOB_FILE_SYNC_LISTEN: "127.0.0.1" };
  assert.equal(acceptablePeerOrigin("http://100.101.2.3:22700", {}), true);
  for (const origin of ["http://127.0.0.1:22700", "http://192.168.1.20:22700", "https://100.101.2.3:22700", "http://100.101.2.3", "http://100.101.2.3:22700/api", "http://[fd7a:115c:a1e0::1]:22700", "http://peer.ts.net:22700", "not a url"]) {
    assert.equal(acceptablePeerOrigin(origin, {}), false, origin);
  }
  assert.equal(acceptablePeerOrigin("http://127.0.0.1:22700", listen), true);
  assert.equal(acceptablePeerOrigin("http://10.1.2.3:22700", listen), true);
  for (const origin of ["http://169.254.169.254:80", "http://8.8.8.8:22700"]) assert.equal(acceptablePeerOrigin(origin, listen), false, `${origin} is never a peer's listener`);
  // "none" moves nothing off the tailnet: relay only, and no wider trust for peers' private or loopback origins.
  for (const origin of ["http://127.0.0.1:8787", "http://10.1.2.3:22700"]) assert.equal(acceptablePeerOrigin(origin, { JOINT_BOB_FILE_SYNC_LISTEN: "none" }), false, origin);
  assert.equal(acceptablePeerOrigin("http://100.101.2.3:22700", { JOINT_BOB_FILE_SYNC_LISTEN: "none" }), true);
});

test("a hello body or answer without a readable fileSync part is an engine-less node; a readable one keeps the origins that qualify", () => {
  assert.deepEqual(parseFileSyncPart({}, {}), { protocol: 0, origins: [] });
  assert.deepEqual(parseFileSyncPart({ ok: true }, {}), { protocol: 0, origins: [] });
  assert.deepEqual(parseFileSyncPart({ fileSync: { protocol: "1" } }, {}), { protocol: 0, origins: [] });
  assert.deepEqual(parseFileSyncPart({ fileSync: { protocol: 2, minProtocol: 1, enabled: true, origins: ["http://100.101.2.3:22700", "http://100.101.2.3:22700", "http://8.8.8.8:1", 7], extra: "a newer field" } }, {}),
    { protocol: 2, minProtocol: 1, enabled: true, origins: ["http://100.101.2.3:22700"] });
  assert.deepEqual(parseFileSyncPart({ fileSync: { protocol: 1, origins: "not a list", enabled: "yes" } }, {}), { protocol: 1, origins: [] }, "a bad value is dropped, not the peer's capability");
});

test("the worker's peer directory carries each peer's announced origins", (t) => {
  forgetPeerFileSync();
  t.after(forgetPeerFileSync);
  const db = sharedFixture();
  assert.deepEqual(peerSpecs(db, [PEER, KEYLESS]).map((spec) => [spec.nodeId, spec.origins]), [[PEER, []]], "a peer without a pinned key is left out");
  const heard: string[] = [];
  t.after(onPeerFileSyncChanged((peer) => heard.push(peer)));
  assert.equal(notePeerFileSync(PEER, { protocol: 1, origins: ["http://100.101.2.3:22700"], via: "hello" }), true);
  assert.equal(notePeerFileSync(PEER, { protocol: 1, origins: ["http://100.101.2.3:22700"], via: "shares" }), false, "the same origins again are no change");
  assert.deepEqual(peerSpecs(db, [PEER]).map((spec) => spec.origins), [["http://100.101.2.3:22700"]]);
  assert.equal(notePeerFileSync(PEER, { protocol: 0, origins: [], via: "answer" }), true, "a downgraded peer");
  assert.deepEqual(heard, [PEER, PEER], "listeners hear of changes only");
});

/* The main thread's half against a stand-in worker (test/fixtures/file-sync-control-worker.ts): the
   configure it builds, records and capability events, and the admin routes. */

const SECOND = "00000000-0000-4000-8000-000000000005";

async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) assert.fail(`${what} did not happen within ${timeoutMs} ms: ${JSON.stringify(value).slice(0, 2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function stubOps(log: string): Promise<Array<{ op: string; args: Record<string, unknown> }>> {
  const text = await readFile(log, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function scanResult(share: string): Record<string, unknown> {
  return { share, changed: 2, tombstones: 2, newGeneration: false, files: 10, hashedBytes: 0, durationMs: 3 };
}

test("the engine's configure, its records and capability events, and the admin routes, against a stand-in worker", { timeout: 60_000 }, async (t) => {
  const [{ default: express }, { app }, { getClusterNode }, { clusterV2Database }, index] = await Promise.all([
    import("express"), import("../src/server/state.js"), import("../src/cluster.js"), import("../src/cluster-v2-store.js"), import("../src/file-sync/index.js"),
  ]);
  const saved = Object.fromEntries(["JOINT_BOB_FILE_SYNC", "JOINT_BOB_FILE_SYNC_PROJECTS", "JOINT_BOB_FILE_SYNC_LISTEN", "JOINT_BOB_FILE_SYNC_PORT"].map((name) => [name, process.env[name]]));
  Object.assign(process.env, { JOINT_BOB_FILE_SYNC: "1", JOINT_BOB_FILE_SYNC_PROJECTS: "alpha", JOINT_BOB_FILE_SYNC_LISTEN: "127.0.0.1", JOINT_BOB_FILE_SYNC_PORT: "22755" });
  const work = await mkdtemp(path.join(os.tmpdir(), "jb-file-sync-control-"));
  const log = path.join(work, "ops.jsonl");
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  getOrCreateClusterIdentity(db, local);
  ensureResourceSharingSchema(db);
  ensurePeerEndpointSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT 'personal', color TEXT,
    path TEXT NOT NULL UNIQUE, mac_path TEXT, sync_folder_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  createSharingCluster(db, { id: CLUSTER, name: "main" }, local);
  for (const node of [PEER, SECOND]) {
    addSharingMember(db, CLUSTER, local, node, getSharingCluster(db, CLUSTER).managerEpoch);
    recordPeerEndpoint(db, { kind: "cluster", id: CLUSTER }, { nodeId: node, name: `node ${node.slice(-1)}`, url: `https://${node.slice(-4)}.example.com` });
    pinClusterPublicKey(db, node, generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString());
  }
  db.prepare("INSERT INTO projects (id, name, path, created_at, updated_at) VALUES ('alpha', 'alpha', ?, ?, ?)").run(path.join(work, "alpha"), NOW, NOW);
  registerOwnedResource(db, { kind: "project", id: "alpha", ownerNodeId: local }, local);
  db.prepare("INSERT INTO cluster_v2_resource_policy VALUES ('project', 'alpha', ?, 1, 0)").run(local);
  setResourceShares(db, local, "project", "alpha", [{ clusterId: CLUSTER, projectId: null }]);
  // PEER owns beta; this node has only its policy so far (no project row, so nothing to sync yet).
  registerOwnedResource(db, { kind: "project", id: "beta", ownerNodeId: PEER }, local);
  db.prepare("INSERT INTO cluster_v2_resource_policy VALUES ('project', 'beta', ?, 1, 0)").run(PEER);

  const recordAt = new Date(Date.now() - 60_000).toISOString();
  const betaEngine = { projectId: "beta", mode: "builtin", generation: 1, updatedAt: recordAt, origin: PEER };
  const peerGlobal = { key: `global:${PEER}`, value: { ...EMPTY_RULE_SETTINGS, userRules: ["*.wav"] }, updatedAt: recordAt, origin: PEER };
  const peerRoute = { peer: PEER, cursor: 3, peerMaxSeq: 3, peerIndexId: "x", peerDigest: null, rulesMatch: true, caughtUp: true, differences: 0, cleanSince: null, route: "direct" };
  const errorsPage = { total: 7, items: [{ path: "a.txt", kind: "error", reason: "Permission denied", at: NOW }] };
  const differencesPage = { total: 1, items: [{ path: "b.txt", kind: "content", since: NOW }] };
  index.useFileSyncWorkerForTests({
    launch: workerLaunch(new URL("./fixtures/file-sync-control-worker.js", import.meta.url)),
    workerData: {
      log, origins: ["http://127.0.0.1:22755"],
      emit: {
        configure: [{ event: "shareState", status: { ...share({ phase: "syncthing" }), peers: [peerRoute] } }],
        announce: [
          { event: "capability", peer: PEER, protocol: 1, enabled: true, origins: ["http://192.168.1.20:22700", "http://169.254.169.254:80"], hostId: "host-peer" },
          // Only beta's engine (PEER owns it) and PEER's own global rules count.
          { event: "records", fromPeer: PEER, engines: [betaEngine, { ...betaEngine, projectId: "alpha" }], settings: [peerGlobal, { ...peerGlobal, key: "project:alpha", origin: SECOND }] },
        ],
      },
      answers: { errors: errorsPage, differences: differencesPage, confirmReplacedRoot: scanResult("tickets:alpha") },
      failures: [{ op: "repair", peer: SECOND, message: "File sync cannot repair yet: this phase of the engine has no network part", code: "unavailable" }],
    },
  });
  app.use(express.json());
  await import("../src/file-sync/admin-routes.js");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/file-sync`;
  t.after(async () => {
    await index.stopFileSync();
    index.useFileSyncWorkerForTests(undefined);
    forgetPeerFileSync();
    await new Promise((resolve) => server.close(resolve));
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(work, { recursive: true, force: true });
  });
  const call = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(`${base}${route}`, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };

  assert.deepEqual(await call("GET", "/errors?share=project:alpha"), { status: 503, body: { error: "File sync is off on this node" } }, "before it starts");
  await index.startFileSync();
  const configures = () => stubOps(log).then((ops) => ops.filter((entry) => entry.op === "configure").map((entry) => entry.args as unknown as ConfigureArgs & { signingKey: string | null }));
  const [first] = await until(configures, (list) => list.length > 0, "the first configure");
  assert.equal(first.signingKey, "ed25519", "the worker signs direct requests with this node's cluster key");
  assert.deepEqual(first.listen, { addresses: ["127.0.0.1"], port: 22755 });
  assert.deepEqual(first.shares.map((spec) => [spec.key, spec.peers]), [["project:alpha", [PEER, SECOND]], ["tickets:alpha", [PEER, SECOND]], ["worktrees:alpha", [PEER, SECOND]]]);
  assert.deepEqual(first.peers.map((spec) => [spec.nodeId, spec.origins, spec.present]), [[PEER, [], true], [SECOND, [], true]]);
  assert.deepEqual(first.records, { engines: [], settings: [] });

  // After its first configure the worker asks peers what changed; what it learns comes back as events.
  const updated = await until(configures, (list) => list.some((args) => args.records.engines.length > 0), "a configure with the accepted records");
  const latest = updated.at(-1)!;
  assert.deepEqual(latest.records, { engines: [betaEngine], settings: [peerGlobal] });
  assert.deepEqual(latest.peers.map((spec) => [spec.nodeId, spec.origins]), [[PEER, ["http://192.168.1.20:22700"]], [SECOND, []]]);
  assert.deepEqual((await stubOps(log)).filter((entry) => entry.op === "announce").map((entry) => entry.args), [{ slept: false }], "one announce after the worker started");

  const status = await call("GET", "/status");
  assert.equal(status.status, 200);
  assert.deepEqual([status.body.worker, status.body.origins, (status.body.config as Record<string, unknown>).shadowProjectsBy], ["running", ["http://127.0.0.1:22755"], "environment"]);
  const peers = (status.body.peers as Array<Record<string, unknown>>).map(({ heardAt, ...rest }) => ({ ...rest, heard: typeof heardAt === "string" }));
  assert.deepEqual(peers, [
    // switchCapable (fix P4+P5): protocol 1 has the engine but not the per-project switch.
    { nodeId: PEER, present: true, protocol: 1, switchCapable: false, enabled: true, origins: ["http://192.168.1.20:22700"], route: "direct", heard: true },
    { nodeId: SECOND, present: true, protocol: null, switchCapable: null, enabled: null, origins: [], route: "none", heard: false },
  ]);

  assert.deepEqual(await call("GET", "/errors?share=project:alpha&page=2&pageSize=5"), { status: 200, body: errorsPage });
  assert.deepEqual(await call("GET", `/differences?share=project:alpha&peer=${PEER}`), { status: 200, body: differencesPage });
  assert.deepEqual(await call("POST", "/repair", { share: "project:alpha", peer: PEER }), { status: 200, body: { ok: true } });
  assert.deepEqual(await call("POST", "/replaced/confirm", { share: "tickets:alpha" }), { status: 200, body: scanResult("tickets:alpha") });
  const asked = (await stubOps(log)).filter((entry) => ["errors", "differences", "repair", "confirmReplacedRoot"].includes(entry.op));
  assert.deepEqual(asked, [
    { op: "errors", args: { share: "project:alpha", offset: 5, limit: 5 } },
    { op: "differences", args: { share: "project:alpha", peer: PEER, offset: 0, limit: 10 } },
    { op: "repair", args: { share: "project:alpha", peer: PEER } },
    { op: "confirmReplacedRoot", args: { share: "tickets:alpha" } },
  ], "pages become offsets; nothing else reaches the worker");

  assert.deepEqual(await call("GET", "/errors?share=project:gamma"), { status: 404, body: { error: "This node does not sync that folder" } });
  assert.deepEqual(await call("GET", "/errors?share=gamma"), { status: 400, body: { error: "Invalid share" } });
  assert.equal((await call("GET", "/errors?share=project:alpha&pageSize=51")).status, 400, "pages are at most 50 long");
  assert.equal((await call("GET", "/differences?share=project:alpha")).status, 400, "differences are per peer");
  assert.deepEqual(await call("GET", `/differences?share=project:alpha&peer=${OUTSIDER}`), { status: 404, body: { error: "That machine does not sync this folder with this node" } });
  assert.deepEqual(await call("POST", "/repair", { share: "project:alpha", peer: SECOND }), { status: 503, body: { error: "File sync cannot repair yet: this phase of the engine has no network part" } });
  assert.equal((await call("POST", "/replaced/confirm", { share: "project:alpha", extra: 1 })).status, 400);
  assert.deepEqual(await call("PUT", "/config", { shadowProjects: ["alpha", "beta"] }), { status: 409, body: { error: "JOINT_BOB_FILE_SYNC_PROJECTS sets which projects file sync checks on this node; change it in the service's environment" } });
  assert.equal((await call("PUT", "/config", { shadowProjects: ["alpha"] })).status, 200, "saving what the environment says is not a conflict");

  await index.stopFileSync();
  assert.equal((await stubOps(log)).at(-1)?.op, "stop");
  assert.deepEqual(await call("GET", "/errors?share=project:alpha"), { status: 503, body: { error: "File sync is off on this node" } });
});
