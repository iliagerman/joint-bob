import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { resolveDataDirectory } from "../src/data-directory.js";
import { BrowserStore } from "../src/browser-store.js";
import { BrowserRuntime } from "../src/browser-runtime.js";
import { prepareProfile } from "../src/browser-profile-files.js";
import { getClusterNode } from "../src/cluster.js";
import { addSharingMember, createSharingCluster, getSharingCluster } from "../src/cluster-sharing-policy.js";
import { clusterV2Database } from "../src/cluster-v2-store.js";

// Shares decide which conversations, on which machines, may use a persistent browser
// profile. The profile entity itself stays on its machine with its native login directory.
const node = randomUUID(), otherNode = randomUUID();
const at = (projectId: string, conversationId?: string, nodeId = node, workspaceId: string | null = null) => ({ nodeId, projectId, conversationId, workspaceId });

test("profiles are shared per conversation, project, workspace, machine, or cluster", async () => {
  const store = new BrowserStore();
  try {
    const home = randomUUID(), other = randomUUID();
    const profile = store.createProfile(home, "Bank login");
    const conversationA = randomUUID(), conversationB = randomUUID();
    assert.equal(store.profileUsable(profile.id, at(home, conversationA)), false, "a fresh profile must not be usable anywhere before a grant");
    store.grantProfileAccess(profile.id, { scope: "conversation", projectId: home, conversationId: conversationA });
    store.grantProfileAccess(profile.id, { scope: "conversation", projectId: other, conversationId: conversationB });
    store.grantProfileAccess(profile.id, { scope: "project", projectId: other });
    assert.equal(store.profileUsable(profile.id, at(home, conversationA)), true);
    assert.equal(store.profileUsable(profile.id, at(home, conversationA, otherNode)), true, "a conversation keeps its profile on whichever machine it runs");
    assert.equal(store.profileUsable(profile.id, at(home, randomUUID())), false, "conversation grants cover only their conversation");
    assert.equal(store.profileUsable(profile.id, at(other, randomUUID())), true, "project grants cover every conversation of that project");
    assert.equal(store.profileUsable(profile.id, at(randomUUID(), randomUUID())), false);

    // A machine share covers every conversation there, and nowhere else.
    store.grantProfileAccess(profile.id, { scope: "node", nodeId: node });
    assert.equal(store.profileUsable(profile.id, at(randomUUID(), randomUUID())), true);
    assert.equal(store.profileUsable(profile.id, at(randomUUID(), randomUUID(), otherNode)), false);
    store.revokeProfileAccess(profile.id, { scope: "node", nodeId: node });

    // A workspace belongs to one machine; the same workspace id elsewhere is another workspace.
    store.grantProfileAccess(profile.id, { scope: "workspace", workspaceId: "personal", nodeId: otherNode });
    assert.equal(store.profileUsable(profile.id, at(randomUUID(), randomUUID(), otherNode, "personal")), true);
    assert.equal(store.profileUsable(profile.id, at(randomUUID(), randomUUID(), node, "personal")), false);
    assert.equal(store.profileUsable(profile.id, at(randomUUID(), randomUUID(), otherNode, "work")), false);

    // A pinned project grant reaches that project on one machine only.
    const pinned = randomUUID();
    store.grantProfileAccess(profile.id, { scope: "project", projectId: pinned, nodeId: node });
    assert.equal(store.profileUsable(profile.id, at(pinned)), true);
    assert.equal(store.profileUsable(profile.id, at(pinned, undefined, otherNode)), false);

    // A cluster share covers its current members while this machine is one of them.
    const db = await clusterV2Database(), local = (await getClusterNode()).id, member = randomUUID(), cluster = randomUUID();
    createSharingCluster(db, { id: cluster, name: "Home" }, local);
    addSharingMember(db, cluster, local, member, getSharingCluster(db, cluster).managerEpoch);
    const shared = store.createProfile(home, "Family login");
    store.grantProfileAccess(shared.id, { scope: "cluster", clusterId: cluster });
    assert.equal(store.profileUsable(shared.id, at(randomUUID(), randomUUID(), member)), true);
    assert.equal(store.profileUsable(shared.id, at(randomUUID(), randomUUID(), local)), true);
    assert.equal(store.profileUsable(shared.id, at(randomUUID(), randomUUID(), randomUUID())), false, "non-members get nothing");
    assert.deepEqual(store.usableProfiles(at(randomUUID(), randomUUID(), member)).map(row => row.id), [shared.id]);

    assert.deepEqual(store.usableProfiles(at(home, conversationA)).map(row => row.id), [profile.id]);
    // Duplicate grants stay a single assignment.
    store.grantProfileAccess(profile.id, { scope: "conversation", projectId: home, conversationId: conversationA });
    assert.equal(store.profileGrants(profile.id).filter(grant => grant.scope === "conversation" && grant.conversationId === conversationA).length, 1);
    // Revocation narrows access grant by grant.
    store.revokeProfileAccess(profile.id, { scope: "project", projectId: other });
    assert.equal(store.profileUsable(profile.id, at(other, randomUUID())), false);
    assert.equal(store.profileUsable(profile.id, at(other, conversationB)), true, "the surviving conversation grant still covers its conversation");
    assert.throws(() => store.revokeProfileAccess(profile.id, { scope: "project", projectId: other }), /not found/i);
    assert.throws(() => store.grantProfileAccess(profile.id, { scope: "node", projectId: other } as never), /grant/i);
    assert.throws(() => store.grantProfileAccess(profile.id, { scope: "conversation", projectId: home }), /grant/i);
    assert.throws(() => store.grantProfileAccess(profile.id, { scope: "workspace", workspaceId: "personal" }), /grant/i, "a workspace share must name its machine");
  } finally { store.close(); }
});

test("profiles remember the sites their tabs used, most recent first", () => {
  const store = new BrowserStore();
  try {
    const profile = store.createProfile(randomUUID(), "Mail login");
    assert.deepEqual(store.profile(profile.id).sites, []);
    store.recordSites(profile.id, ["https://mail.google.com", "about:blank"]);
    store.recordSites(profile.id, ["https://calendar.google.com", "https://mail.google.com"]);
    assert.deepEqual(store.profile(profile.id).sites, ["https://calendar.google.com", "https://mail.google.com"]);
    assert.equal(store.profile(profile.id).grants, undefined, "plain profile reads do not carry grants");
  } finally { store.close(); }
});

test("conversation deletion removes that conversation's assignment but not the profile entity or other grants", () => {
  const store = new BrowserStore();
  try {
    const home = randomUUID();
    const profile = store.createProfile(home, "Shared login");
    const conversation = randomUUID();
    store.grantProfileAccess(profile.id, { scope: "conversation", projectId: home, conversationId: conversation });
    store.grantProfileAccess(profile.id, { scope: "conversation", projectId: home, conversationId: randomUUID() });
    store.grantProfileAccess(profile.id, { scope: "project", projectId: home });
    assert.equal(store.dropConversationGrants(home, conversation), 1);
    assert.equal(store.profileUsable(profile.id, at(home, conversation)), true, "the project grant still covers the deleted conversation id");
    assert.equal(store.profileGrants(profile.id).filter(grant => grant.conversationId === conversation).length, 0);
    assert.equal(store.profileGrants(profile.id).length, 2, "other assignments survive");
    assert.ok(store.profile(profile.id), "the durable entity survives conversation deletion");
    assert.equal(store.dropConversationGrants(home, conversation), 0, "second deletion is a no-op");
    // Grants are scoped to their project: another project's conversation grant is untouched.
    const foreign = randomUUID(), foreignConversation = randomUUID();
    store.grantProfileAccess(profile.id, { scope: "conversation", projectId: foreign, conversationId: foreignConversation });
    assert.equal(store.dropConversationGrants(home, foreignConversation), 0);
    assert.equal(store.profileUsable(profile.id, at(foreign, foreignConversation)), true);
  } finally { store.close(); }
});

test("grant migration keeps every existing profile's reach and never widens it", t => {
  const previous = process.env.PI_WEB_DATA_DIR;
  const root = path.join(resolveDataDirectory(), randomUUID());
  process.env.PI_WEB_DATA_DIR = root;
  mkdirSync(root, { recursive: true });
  t.after(() => { process.env.PI_WEB_DATA_DIR = previous; rmSync(root, { recursive: true, force: true }); });
  const db = new DatabaseSync(path.join(root, "node.db"));
  db.exec(`CREATE TABLE browser_sessions (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, engine TEXT NOT NULL, conversationId TEXT NOT NULL,
    appNodeId TEXT NOT NULL, url TEXT, profileId TEXT, state TEXT NOT NULL,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, error TEXT);
    CREATE TABLE browser_profiles (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, label TEXT NOT NULL,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, stateEncrypted TEXT NOT NULL);
    CREATE TABLE cluster_node (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), id TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO cluster_node VALUES (1, '${node}', 'Home', 'http://home', 'then', 'then');
    INSERT INTO browser_profiles VALUES ('legacy-a','alpha','Alpha login','then','then','');
    INSERT INTO browser_profiles VALUES ('legacy-b','beta','Beta login','then','then','');
    INSERT INTO browser_sessions VALUES ('a','alpha','pi','conversation-a','node','https://example.com','legacy-a','closed','then','then',NULL);
    INSERT INTO browser_sessions VALUES ('a2','alpha','claude','conversation-a2','node','https://example.com','legacy-a','interrupted','then','then',NULL);
    INSERT INTO browser_sessions VALUES ('a3','alpha','pi','conversation-a','node','https://example.com','legacy-a','closed','then','later',NULL);`);
  db.close();
  const store = new BrowserStore();
  let closed = false;
  try {
    // Existing conversation permissions survive exactly: every conversation that
    // had run the profile keeps it, one conversation grant per distinct pair, and
    // nothing broadens to the whole project.
    assert.deepEqual(store.profileGrants("legacy-a").map(({ scope, projectId, conversationId }) => ({ scope, projectId, conversationId })), [
      { scope: "conversation", projectId: "alpha", conversationId: "conversation-a" },
      { scope: "conversation", projectId: "alpha", conversationId: "conversation-a2" },
    ]);
    assert.deepEqual(store.profileGrants("legacy-b"), [], "a profile no conversation ever ran stays a dormant entity");
    assert.equal(store.profileUsable("legacy-a", at("alpha", "conversation-a")), true);
    assert.equal(store.profileUsable("legacy-a", at("alpha", "conversation-a", otherNode)), true, "legacy profiles kept their cross-machine reach");
    assert.equal(store.profileUsable("legacy-a", at("alpha", randomUUID())), false, "migration must not broaden attachment to the whole project");
    store.close(); closed = true;
    const reopened = new BrowserStore();
    try { assert.equal(reopened.profileGrants("legacy-a").length, 2); }
    finally { reopened.close(); }
  } finally { if (!closed) store.close(); }

  // The sharing migration: "global" becomes this machine, and grants the old relay
  // toggle kept on this machine are pinned to it.
  const upgraded = new DatabaseSync(path.join(root, "node.db"));
  upgraded.exec(`DELETE FROM browser_migrations WHERE id = 'profile-grants-sharing-scopes';
    INSERT INTO browser_profiles (id, projectId, label, createdAt, updatedAt, stateEncrypted, persistent, crossNodeAccess) VALUES ('island','gamma','Island login','then','then','',1,0);
    INSERT INTO browser_profile_grants (profileId, scope, projectId, conversationId, createdAt) VALUES ('island','global',NULL,NULL,'then'), ('island','project','gamma',NULL,'then'), ('legacy-b','global',NULL,NULL,'then');`);
  upgraded.close();
  const migrated = new BrowserStore();
  try {
    assert.deepEqual(migrated.profileGrants("island").map(({ scope, projectId, nodeId }) => ({ scope, projectId, nodeId })), [
      { scope: "node", projectId: undefined, nodeId: node },
      { scope: "project", projectId: "gamma", nodeId: node },
    ]);
    assert.equal(migrated.profileUsable("island", at("gamma", randomUUID())), true);
    assert.equal(migrated.profileUsable("island", at("gamma", randomUUID(), otherNode)), false, "a profile kept off the relay stays on its machine");
    assert.equal(migrated.profileUsable("legacy-b", at(randomUUID(), randomUUID())), true, "global became this machine");
    assert.equal(migrated.profileUsable("legacy-b", at(randomUUID(), randomUUID(), otherNode)), false, "and never another one");
  } finally { migrated.close(); }
});

test("a second conversation cannot start a profile that is active elsewhere and gets a clear error", () => {
  const store = new BrowserStore();
  try {
    const home = randomUUID();
    const profile = store.createProfile(home, "Busy login");
    store.grantProfileAccess(profile.id, { scope: "project", projectId: home });
    const first = { projectId: home, engine: "pi" as const, conversationId: randomUUID(), appNodeId: randomUUID(), profileId: profile.id };
    store.create(first);
    assert.throws(() => store.create({ ...first, conversationId: randomUUID() }), /active in another conversation/i);
    // Closing the session releases the lease for any granted conversation.
    store.finish(store.list(first)[0].id, "closed");
    const second = store.create({ ...first, conversationId: randomUUID() });
    store.finish(second.id, "closed");
  } finally { store.close(); }
});

test("session history survives its profile's deletion and stays readable", async () => {
  const store = new BrowserStore();
  const runtime = new BrowserRuntime();
  try {
    const home = randomUUID();
    const profile = store.createProfile(home, "Deleted login");
    store.grantProfileAccess(profile.id, { scope: "project", projectId: home });
    const session = store.create({ projectId: home, engine: "pi", conversationId: randomUUID(), appNodeId: randomUUID(), profileId: profile.id, url: "https://example.com" });
    store.finish(session.id, "closed");
    store.deleteProfile(profile.id, home);
    // The closed session keeps its history row; reading it must not throw over the
    // profile that no longer exists.
    assert.equal(store.list({ conversationId: session.conversationId })[0].id, session.id);
    const view = await runtime.get(session.id);
    assert.equal(view.profileId, profile.id);
    assert.equal(view.profileLabel, undefined, "a deleted profile contributes no label");
    assert.deepEqual(await runtime.list({ projectId: home }), [view]);
  } finally { runtime.close(); store.close(); }
});

test("a refused profile delete never removes the native login directory", async () => {
  const store = new BrowserStore();
  const runtime = new BrowserRuntime();
  try {
    const home = randomUUID();
    const profile = store.createProfile(home, "Island login");
    const directory = await prepareProfile(profile.id);
    // Deleting from a project the profile is not granted to must refuse before the
    // filesystem is touched: the directory and the entity both survive.
    await assert.rejects(() => runtime.deleteProfile(profile.id, randomUUID()), /not found in this project/i);
    const info = await stat(directory);
    assert.ok(info.isDirectory(), "the native login directory must survive a refused delete");
    assert.equal(store.profile(profile.id).id, profile.id, "the durable entity must survive a refused delete");
  } finally { runtime.close(); store.close(); }
});
