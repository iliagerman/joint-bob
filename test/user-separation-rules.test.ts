// Rules of the wall that a route sweep doesn't reach: who receives what another node shares,
// whose agents load the node's MCP servers, and what a deleted conversation's agents keep.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { nodeMcpServersApply, runInRuntime } from "../src/account-runtime.js";
import { accountIdFor } from "../src/accounts.js";
import { browserAgentEnvironment, browserAgentIdentity } from "../src/browser-agent.js";
import { accountReceivesFrom } from "../src/cluster-accounts.js";
import { revokeAgentCapabilities } from "../src/agent-capabilities.js";
import { ntfyAgentEnvironment, ntfyAgentIdentity } from "../src/ntfy-agent.js";
import { accountOfSomeoneElse } from "../src/ownership.js";

const LOCAL = "11111111-1111-4111-8111-111111111111", PEER = "22222222-2222-4222-8222-222222222222", TWIN = "33333333-3333-4333-8333-333333333333";
const FAMILY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", WORK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function node(): { db: DatabaseSync; admin: { accountId: string; role: string }; dana: { accountId: string; role: string } } {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE cluster_node (singleton INTEGER PRIMARY KEY, id TEXT NOT NULL);
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, home_node_id TEXT, role TEXT, account_id TEXT);
    CREATE TABLE sharing_memberships (cluster_id TEXT NOT NULL, node_id TEXT NOT NULL);
    CREATE TABLE cluster_v2_twin_relationships (relationship_id TEXT, peer_node_id TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE cluster_local_members (cluster_id TEXT NOT NULL, account_id TEXT NOT NULL, joined_at TEXT NOT NULL, PRIMARY KEY (cluster_id, account_id));`);
  db.prepare("INSERT INTO cluster_node VALUES (1, ?)").run(LOCAL);
  const admin = { accountId: accountIdFor(LOCAL, "ana"), role: "admin" }, dana = { accountId: accountIdFor(LOCAL, "dana"), role: "member" };
  db.prepare("INSERT INTO users VALUES ('u1', 'ana', NULL, 'admin', ?), ('u2', 'dana', NULL, 'member', ?)").run(admin.accountId, dana.accountId);
  for (const cluster of [FAMILY, WORK]) for (const member of [LOCAL, PEER]) db.prepare("INSERT INTO sharing_memberships VALUES (?, ?)").run(cluster, member);
  // Ana joined Family, Dana joined Work.
  db.prepare("INSERT INTO cluster_local_members VALUES (?, ?, 'now'), (?, ?, 'now')").run(FAMILY, admin.accountId, WORK, dana.accountId);
  db.prepare("INSERT INTO cluster_v2_twin_relationships VALUES ('r1', ?, 'active')").run(TWIN);
  return { db, admin, dana };
}

test("what another node shares is for the people who joined that cluster, the admin like anyone", () => {
  const { db, admin, dana } = node();
  assert.equal(accountReceivesFrom(db, dana, PEER, [WORK]), true, "Dana sees what came through the cluster she joined");
  assert.equal(accountReceivesFrom(db, admin, PEER, [WORK]), false, "the admin doesn't, not having joined it");
  assert.equal(accountReceivesFrom(db, admin, PEER, [FAMILY]), true);
  assert.equal(accountReceivesFrom(db, dana, PEER, [FAMILY]), false);
  assert.equal(accountReceivesFrom(db, dana, PEER), true, "with no cluster named, any cluster shared with that node counts");
  assert.equal(accountReceivesFrom(db, admin, TWIN), true, "a twin is the admin's own machine");
  assert.equal(accountReceivesFrom(db, dana, TWIN), false, "and nobody else's");
  const stranger = "44444444-4444-4444-8444-444444444444";
  assert.equal(accountReceivesFrom(db, dana, stranger), false, "a node sharing no cluster reaches no member");
  assert.equal(accountReceivesFrom(db, admin, stranger), true, "it stays the admin's, as before people joined clusters");
});

test("a member's and a visitor's account are told apart from the admin's, under any of its ids", () => {
  const { db, admin, dana } = node();
  db.prepare("INSERT INTO users VALUES ('u3', 'vera', ?, NULL, ?)").run(PEER, accountIdFor(PEER, "vera"));
  assert.equal(accountOfSomeoneElse(dana.accountId, db), true);
  assert.equal(accountOfSomeoneElse(accountIdFor(PEER, "vera"), db), true);
  assert.equal(accountOfSomeoneElse(admin.accountId, db), false);
  assert.equal(accountOfSomeoneElse(accountIdFor(TWIN, "ana"), db), false, "the admin's id from before a twin was paired is still the admin's");
});

test("the node's MCP servers load into the admin's agents only", () => {
  const admin = "a".repeat(32), member = "b".repeat(32);
  assert.equal(nodeMcpServersApply(admin), true, "the service's own runs keep them");
  assert.equal(runInRuntime({ key: admin, name: "ana", home: "/home/jb-ana" }, () => nodeMcpServersApply(admin)), true);
  assert.equal(runInRuntime({ key: member, name: "dana", home: "/home/jb-dana" }, () => nodeMcpServersApply(admin)), false);
  assert.equal(runInRuntime({ key: "cluster:x", name: "c1", home: "/home/jb-c1" }, () => nodeMcpServersApply(admin)), false);
});

test("a deleted conversation's agents keep no token, and a deleted project's keep none at all", () => {
  const project = "project-one";
  const tokens = (conversation: string) => ({ browser: browserAgentEnvironment(project, "pi", conversation).JOINT_BOB_BROWSER_TOKEN!, ntfy: ntfyAgentEnvironment(project, "pi", conversation).JOINT_BOB_NTFY_TOKEN! });
  const first = tokens("conversation-a"), second = tokens("conversation-b"), elsewhere = ntfyAgentEnvironment("project-two", "pi", "conversation-a").JOINT_BOB_NTFY_TOKEN!;
  revokeAgentCapabilities(project, "conversation-a");
  assert.equal(browserAgentIdentity(first.browser), undefined);
  assert.equal(ntfyAgentIdentity(first.ntfy), undefined);
  assert.ok(browserAgentIdentity(second.browser), "another conversation's agent is untouched");
  assert.ok(ntfyAgentIdentity(second.ntfy));
  revokeAgentCapabilities(project);
  assert.equal(browserAgentIdentity(second.browser), undefined);
  assert.equal(ntfyAgentIdentity(second.ntfy), undefined);
  assert.ok(ntfyAgentIdentity(elsewhere), "another project's agent is untouched");
});
