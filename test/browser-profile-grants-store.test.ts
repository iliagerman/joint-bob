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

// Scope grants decide which conversations may use a persistent browser profile.
// The profile entity itself stays node-local with its native login directory.
test("profiles are granted per conversation, project, or globally with multiple assignments", () => {
  const store = new BrowserStore();
  try {
    const home = randomUUID(), other = randomUUID();
    const profile = store.createProfile(home, "Bank login");
    const conversationA = randomUUID(), conversationB = randomUUID();
    assert.equal(store.profileUsable(profile.id, home, conversationA), false, "a fresh profile must not be usable anywhere before a grant");
    store.grantProfileAccess(profile.id, { scope: "conversation", projectId: home, conversationId: conversationA });
    store.grantProfileAccess(profile.id, { scope: "conversation", projectId: other, conversationId: conversationB });
    store.grantProfileAccess(profile.id, { scope: "project", projectId: other });
    assert.equal(store.profileUsable(profile.id, home, conversationA), true);
    assert.equal(store.profileUsable(profile.id, home, randomUUID()), false, "conversation grants cover only their conversation");
    assert.equal(store.profileUsable(profile.id, other, randomUUID()), true, "project grants cover every conversation of that project");
    assert.equal(store.profileUsable(profile.id, randomUUID(), randomUUID()), false);
    store.grantProfileAccess(profile.id, { scope: "global" });
    assert.equal(store.profileUsable(profile.id, randomUUID(), randomUUID()), true, "global grants cover the whole node");
    assert.deepEqual(store.usableProfiles(home, conversationA).map(row => row.id), [profile.id]);
    assert.deepEqual(store.usableProfiles(randomUUID(), randomUUID()).map(row => row.id), [profile.id], "global profiles are usable from every project");
    // Duplicate grants stay a single assignment.
    store.grantProfileAccess(profile.id, { scope: "conversation", projectId: home, conversationId: conversationA });
    assert.equal(store.profileGrants(profile.id).filter(grant => grant.scope === "conversation" && grant.conversationId === conversationA).length, 1);
    // Revocation narrows access grant by grant.
    store.revokeProfileAccess(profile.id, { scope: "global" });
    assert.equal(store.profileUsable(profile.id, randomUUID(), randomUUID()), false);
    store.revokeProfileAccess(profile.id, { scope: "project", projectId: other });
    assert.equal(store.profileUsable(profile.id, other, randomUUID()), false);
    assert.equal(store.profileUsable(profile.id, other, conversationB), true, "the surviving conversation grant still covers its conversation");
    assert.throws(() => store.revokeProfileAccess(profile.id, { scope: "project", projectId: other }), /not found/i);
    assert.throws(() => store.grantProfileAccess(profile.id, { scope: "global", projectId: other }), /grant/i);
    assert.throws(() => store.grantProfileAccess(profile.id, { scope: "conversation", projectId: home }), /grant/i);
  } finally { store.close(); }
});

test("cross-node access is an independent per-profile toggle: new profiles default off, the toggle persists", () => {
  const store = new BrowserStore();
  try {
    const home = randomUUID();
    const profile = store.createProfile(home, "Island login");
    assert.equal(store.profile(profile.id).crossNodeAccess, false, "new profiles are node-only until cross-node access is explicitly allowed");
    store.setProfileCrossNode(profile.id, true);
    assert.equal(store.profile(profile.id).crossNodeAccess, true);
    assert.equal(store.profile(profile.id).grants, undefined, "plain profile reads do not carry grants");
    // Grants and the toggle are independent: a globally granted profile can still be node-only.
    store.grantProfileAccess(profile.id, { scope: "global" });
    assert.equal(store.profile(profile.id).crossNodeAccess, true);
    store.setProfileCrossNode(profile.id, false);
  } finally { store.close(); }
  const reopened = new BrowserStore();
  try {
    assert.equal(reopened.profiles(randomUUID()).length, 0);
  } finally { reopened.close(); }
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
    assert.equal(store.profileUsable(profile.id, home, conversation), true, "the project grant still covers the deleted conversation id");
    assert.equal(store.profileGrants(profile.id).filter(grant => grant.conversationId === conversation).length, 0);
    assert.equal(store.profileGrants(profile.id).length, 2, "other assignments survive");
    assert.ok(store.profile(profile.id), "the durable entity survives conversation deletion");
    assert.equal(store.dropConversationGrants(home, conversation), 0, "second deletion is a no-op");
    // Grants are scoped to their project: another project's conversation grant is untouched.
    const foreign = randomUUID(), foreignConversation = randomUUID();
    store.grantProfileAccess(profile.id, { scope: "conversation", projectId: foreign, conversationId: foreignConversation });
    assert.equal(store.dropConversationGrants(home, foreignConversation), 0);
    assert.equal(store.profileUsable(profile.id, foreign, foreignConversation), true);
  } finally { store.close(); }
});

test("grant migration preserves every existing profile's project scope and cross-node access", t => {
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
    // A conversation with several sessions (here conversation-a, twice) still
    // backfills exactly one grant; reopening sessions is the normal case.
    assert.deepEqual(store.profileGrants("legacy-b"), [], "a profile no conversation ever ran stays a dormant entity");
    assert.equal(store.profileUsable("legacy-a", "alpha", "conversation-a"), true);
    assert.equal(store.profileUsable("legacy-a", "alpha", randomUUID()), false, "migration must not broaden attachment to the whole project");
    assert.equal(store.profile("legacy-a").crossNodeAccess, true, "legacy profiles keep their cross-node behavior");
    assert.equal(store.profile("legacy-b").crossNodeAccess, true);
    // Reopening does not duplicate the backfilled grants.
    store.close(); closed = true;
    const reopened = new BrowserStore();
    try { assert.equal(reopened.profileGrants("legacy-a").length, 2); }
    finally { reopened.close(); }
  } finally { if (!closed) store.close(); }
});

test("a second conversation cannot start a profile that is active elsewhere and gets a clear error", () => {
  const store = new BrowserStore();
  try {
    const home = randomUUID();
    const profile = store.createProfile(home, "Busy login");
    store.grantProfileAccess(profile.id, { scope: "global" });
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
    store.grantProfileAccess(profile.id, { scope: "global" });
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
