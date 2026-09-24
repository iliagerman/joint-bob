import assert from "node:assert/strict";
import { execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";
import type { BrowserProfile } from "../src/browser-types.js";

type ProfilesReply = { profiles: BrowserProfile[] };
type AccessReply = { profile: BrowserProfile };

// The profile entity is node-owned durable state. Tests create it without
// launching a browser by writing through the same store the server uses.
async function createProfile(node: SeededNode, environment: DevEnvironment, projectId: string, label: string): Promise<string> {
  const code = `import { BrowserStore } from './src/browser-store.ts';
const store = new BrowserStore();
const profile = store.createProfile(${JSON.stringify(projectId)}, ${JSON.stringify(label)});
store.close();
console.log(profile.id);`;
  const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: process.cwd(), env: { ...process.env, HOME: environment.home, JOINT_BOB_DATA_DIR: node.dataDir }, timeout: 15000,
  });
  return result.stdout.trim();
}

async function issueAgentToken(node: SeededNode, environment: DevEnvironment, projectId: string, conversationId: string): Promise<{ url: string; token: string }> {
  const code = `import { browserAgentEnvironment } from './src/browser-agent.ts';
const environment = browserAgentEnvironment(${JSON.stringify(projectId)}, 'pi', ${JSON.stringify(conversationId)});
console.log(JSON.stringify({ url: environment.JOINT_BOB_BROWSER_URL, token: environment.JOINT_BOB_BROWSER_TOKEN }));`;
  const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: process.cwd(), env: { ...process.env, HOME: environment.home, JOINT_BOB_DATA_DIR: node.dataDir, PORT: String(node.port) }, timeout: 15000,
  });
  return JSON.parse(result.stdout);
}

test("browser profile scope grants gate every server and agent path while conversation deletion keeps the entity", { timeout: 120000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-profile-grants-"));
  const servers: ChildProcess[] = [];
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    servers.push(await startDevNode(environment, node));
    const auth = await signIn(environment, node);
    const project = node.projects[0];
    const otherProject = node.projects[1];
    const grantedConversation = randomUUID();
    const strangerConversation = randomUUID();
    const profileId = await createProfile(node, environment, project.id, "Bank login");

    // A profile with no grants is closed to conversations: the agent never sees it.
    // The owner node's human does see it as a dormant home-project entity to manage
    // and grant — without granting any conversation implicit access.
    const emptyHuman = await api<ProfilesReply>(node, auth, "GET", `/browser/profiles?${new URLSearchParams({ projectId: project.id, conversationId: grantedConversation })}`);
    assert.equal(emptyHuman.status, 200);
    assert.deepEqual(emptyHuman.body.profiles.map(profile => profile.id), [profileId], "a dormant home-project entity stays visible to the local human for management");
    assert.deepEqual(emptyHuman.body.profiles[0].grants, [], "the dormant listing shows it has no access grants");
    const foreignProject = await api<ProfilesReply>(node, auth, "GET", `/browser/profiles?${new URLSearchParams({ projectId: otherProject.id, conversationId: randomUUID() })}`);
    assert.equal(foreignProject.body.profiles.length, 0, "a dormant profile is not offered in projects it has no relationship to");

    // Human grants the profile to one conversation of the project.
    const granted = await api<AccessReply>(node, auth, "PUT", `/browser/profiles/${profileId}/access?${new URLSearchParams({ projectId: project.id, conversationId: grantedConversation })}`, { grant: { scope: "conversation", projectId: project.id, conversationId: grantedConversation } });
    assert.equal(granted.status, 200, JSON.stringify(granted.body));
    assert.deepEqual(granted.body.profile.grants!.map(({ scope, projectId, conversationId }) => ({ scope, projectId, conversationId })), [{ scope: "conversation", projectId: project.id, conversationId: grantedConversation }]);

    // The conversation-bound listing shows it. Another conversation of the same
    // project cannot use it — but the owner node's human still sees the
    // home-project entity with its real grants, because a hidden listing would
    // make Access management impossible.
    const visible = await api<ProfilesReply>(node, auth, "GET", `/browser/profiles?${new URLSearchParams({ projectId: project.id, conversationId: grantedConversation })}`);
    assert.deepEqual(visible.body.profiles.map(profile => profile.id), [profileId]);
    const strangerView = await api<ProfilesReply>(node, auth, "GET", `/browser/profiles?${new URLSearchParams({ projectId: project.id, conversationId: strangerConversation })}`);
    assert.deepEqual(strangerView.body.profiles.map(profile => profile.id), [profileId], "the local human keeps managing a home-project profile granted only to another conversation");
    assert.deepEqual(strangerView.body.profiles[0].grants!.map(({ scope, projectId, conversationId }) => ({ scope, projectId, conversationId })), [{ scope: "conversation", projectId: project.id, conversationId: grantedConversation }], "the manageable listing carries the profile's real grants");
    assert.equal(visible.body.profiles[0].crossNodeAccess, false, "new profiles are node-only until cross-node access is explicitly allowed");

    // Management is bound to the actual profile, not the project id in the URL: an
    // arbitrary project the profile is not granted to cannot manage it.
    const ungrantedProject = node.projects[2];
    const hijack = await api(node, auth, "PUT", `/browser/profiles/${profileId}/access?${new URLSearchParams({ projectId: ungrantedProject.id, conversationId: randomUUID() })}`, { grant: { scope: "global" } });
    assert.equal(hijack.status, 403, JSON.stringify(hijack.body));
    assert.match(hijack.body.error, /cannot be managed|not granted/i);
    assert.equal((await api<AccessReply>(node, auth, "PUT", `/browser/profiles/${profileId}/access?${new URLSearchParams({ projectId: ungrantedProject.id })}`, {})).status, 403, "even a read of access state requires visibility");

    // Project and global grants widen access; multiple projects can hold assignments.
    assert.equal((await api(node, auth, "PUT", `/browser/profiles/${profileId}/access?${new URLSearchParams({ projectId: project.id, conversationId: grantedConversation })}`, { grant: { scope: "project", projectId: otherProject.id } })).status, 200);
    const otherList = await api<ProfilesReply>(node, auth, "GET", `/browser/profiles?${new URLSearchParams({ projectId: otherProject.id, conversationId: randomUUID() })}`);
    assert.deepEqual(otherList.body.profiles.map(profile => profile.id), [profileId]);

    // The agent bridge enforces the same grants. An ungranted conversation may not
    // start the profile, and that refusal happens before any browser launch.
    const agent = await issueAgentToken(node, environment, project.id, strangerConversation);
    const agentRequest = (body: unknown) => fetch(agent.url, {
      method: "POST", headers: { Authorization: `Bearer ${agent.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    const refused = await agentRequest({ operation: "start", profileId });
    const refusal = await refused.json() as { error: string };
    assert.equal(refused.status, 403, JSON.stringify(refusal));
    assert.match(refusal.error, /not granted to this conversation/i);
    const agentProfiles = await (await agentRequest({ operation: "profiles" })).json() as ProfilesReply;
    assert.equal(agentProfiles.profiles.length, 0, "the agent lists only profiles granted to its conversation");

    // The granted conversation sees the profile through the agent bridge.
    const agentGranted = await issueAgentToken(node, environment, project.id, grantedConversation);
    const grantedList = await (await fetch(agentGranted.url, { method: "POST", headers: { Authorization: `Bearer ${agentGranted.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ operation: "profiles" }), signal: AbortSignal.timeout(30000) })).json() as ProfilesReply;
    assert.deepEqual(grantedList.profiles.map(profile => profile.id), [profileId]);

    // Agents cannot manage grants, cross-node access, or delete the entity.
    for (const body of [
      { grant: { scope: "global" } },
      { revoke: { scope: "conversation", projectId: project.id, conversationId: grantedConversation } },
      { crossNodeAccess: false },
    ]) {
      const attempt = await fetch(agentGranted.url, { method: "PUT", headers: { Authorization: `Bearer ${agentGranted.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      assert.equal(attempt.status, 401, "the agent bridge never reaches profile management");
    }
    const agentDelete = await fetch(`${node.url}/api/browser/profiles/${profileId}?${new URLSearchParams({ projectId: project.id })}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${agent.token}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(30000),
    });
    assert.ok(agentDelete.status === 401 || agentDelete.status === 403, "agent tokens cannot delete profiles");

    // One access change per request: a combined update must be refused whole,
    // before any mutation, so a failing later step cannot leave earlier changes applied.
    const before = await api<AccessReply>(node, auth, "PUT", `/browser/profiles/${profileId}/access?${new URLSearchParams({ projectId: project.id, conversationId: grantedConversation })}`, {});
    const combined = await api<AccessReply>(node, auth, "PUT", `/browser/profiles/${profileId}/access?${new URLSearchParams({ projectId: project.id, conversationId: grantedConversation })}`, { crossNodeAccess: false, grant: { scope: "project", projectId: "does-not-exist" } });
    assert.equal(combined.status, 400, JSON.stringify(combined.body));
    const after = await api<AccessReply>(node, auth, "PUT", `/browser/profiles/${profileId}/access?${new URLSearchParams({ projectId: project.id, conversationId: grantedConversation })}`, {});
    assert.deepEqual(after.body.profile.grants!.map(({ scope }) => scope), before.body.profile.grants!.map(({ scope }) => scope), "a refused combined request must not change grants");
    assert.equal(after.body.profile.crossNodeAccess, before.body.profile.crossNodeAccess, "a refused combined request must not change the cross-node toggle");

    // Cross-node access is an independent toggle: turning it off keeps grants intact.
    const restricted = await api<AccessReply>(node, auth, "PUT", `/browser/profiles/${profileId}/access?${new URLSearchParams({ projectId: project.id, conversationId: grantedConversation })}`, { crossNodeAccess: true });
    assert.equal(restricted.status, 200);
    assert.equal(restricted.body.profile.crossNodeAccess, true);
    assert.equal(restricted.body.profile.grants!.length, 2, "grants are untouched by the cross-node toggle");

    // Conversation deletion removes that conversation's assignment, not the entity or other grants.
    const sessions = await api<{ sessions: Array<{ id: string; harnessId: string; title: string }> }>(node, auth, "GET", `/projects/${project.id}/sessions`);
    const victim = sessions.body.sessions.find(session => session.harnessId === "claude")!;
    assert.match(victim.id, /^[0-9a-f-]{36}$/, "deletion requires a UUID session id; seeded Claude conversations provide one");
    const deletedConversation = victim.id;
    assert.equal((await api(node, auth, "PUT", `/browser/profiles/${profileId}/access?${new URLSearchParams({ projectId: project.id, conversationId: grantedConversation })}`, { grant: { scope: "conversation", projectId: project.id, conversationId: deletedConversation } })).status, 200);
    const deleteResponse = await fetch(`${node.url}/api/projects/${project.id}/sessions?${new URLSearchParams({ engine: "claude", sessionId: deletedConversation })}`, {
      method: "DELETE", headers: { Cookie: auth.cookie, "x-csrf-token": auth.csrfToken }, signal: AbortSignal.timeout(30000),
    });
    assert.equal(deleteResponse.status, 204, await deleteResponse.text().catch(() => ""));
    const afterDeletion = await api<ProfilesReply>(node, auth, "GET", `/browser/profiles?${new URLSearchParams({ projectId: otherProject.id, conversationId: randomUUID() })}`);
    assert.deepEqual(afterDeletion.body.profiles.map(profile => profile.id), [profileId], "the durable entity survives conversation deletion");
    const access = await api<AccessReply>(node, auth, "PUT", `/browser/profiles/${profileId}/access?${new URLSearchParams({ projectId: otherProject.id, conversationId: randomUUID() })}`, {});
    assert.equal(access.body.profile.grants!.filter(grant => grant.conversationId === deletedConversation).length, 0, "the deleted conversation's assignment is gone");
    assert.equal(access.body.profile.grants!.length, 2, "the surviving assignments are untouched");
  } finally {
    await Promise.all(servers.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});

test("a revoked grant stops a restore-pending session from resurrecting and frees its lease", { timeout: 120000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-profile-restore-"));
  const servers: ChildProcess[] = [];
  const conversation = randomUUID();
  const grantedConversation = randomUUID();
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const project = node.projects[0];
    // A profile with a restore-pending session whose conversation later lost access.
    const setup = `import { BrowserStore } from './src/browser-store.ts';
const store = new BrowserStore();
const profile = store.createProfile(${JSON.stringify(project.id)}, 'Revoked restore');
store.grantProfileAccess(profile.id, { scope: 'conversation', projectId: ${JSON.stringify(project.id)}, conversationId: ${JSON.stringify(conversation)} });
const session = store.create({ projectId: ${JSON.stringify(project.id)}, engine: 'pi', conversationId: ${JSON.stringify(conversation)}, appNodeId: ${JSON.stringify(randomUUID())}, profileId: profile.id, url: 'https://example.com' });
store.finish(session.id, 'interrupted', 'Restart pending', true);
store.revokeProfileAccess(profile.id, { scope: 'conversation', projectId: ${JSON.stringify(project.id)}, conversationId: ${JSON.stringify(conversation)} });
store.grantProfileAccess(profile.id, { scope: 'conversation', projectId: ${JSON.stringify(project.id)}, conversationId: ${JSON.stringify(grantedConversation)} });
store.close();
console.log(JSON.stringify({ profileId: profile.id, sessionId: session.id }));`;
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", setup], {
      cwd: process.cwd(), env: { ...process.env, HOME: environment.home, JOINT_BOB_DATA_DIR: node.dataDir }, timeout: 15000,
    });
    const { profileId, sessionId } = JSON.parse(result.stdout) as { profileId: string; sessionId: string };
    servers.push(await startDevNode(environment, node));
    const auth = await signIn(environment, node);
    // Any browser endpoint instantiates the runtime, whose restore pass runs first.
    assert.equal((await api(node, auth, "GET", "/browser/status")).status, 200);
    const sessions = await api<{ sessions: Array<{ id: string; state: string; restoreOnRestart: boolean; error?: string }> }>(node, auth, "GET", `/browser/sessions?${new URLSearchParams({ projectId: project.id, engine: "pi", conversationId: conversation })}`);
    const revived = sessions.body.sessions.find(row => row.id === sessionId)!;
    assert.equal(revived.state, "interrupted");
    assert.equal(revived.restoreOnRestart, false, "a revoked conversation must not keep holding the profile's live lease");
    assert.match(revived.error ?? "", /grant was revoked/i);
    // The lease is free: the conversation that is still granted may claim the profile.
    const claim = `import { BrowserStore } from './src/browser-store.ts';
const store = new BrowserStore();
const session = store.create({ projectId: ${JSON.stringify(project.id)}, engine: 'pi', conversationId: ${JSON.stringify(grantedConversation)}, appNodeId: ${JSON.stringify(randomUUID())}, profileId: ${JSON.stringify(profileId)} });
store.finish(session.id, 'closed');
store.close();
console.log('claimed');`;
    const claimed = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", claim], {
      cwd: process.cwd(), env: { ...process.env, HOME: environment.home, JOINT_BOB_DATA_DIR: node.dataDir }, timeout: 15000,
    });
    assert.equal(claimed.stdout.trim(), "claimed");
    t.diagnostic("Revoked restore-pending session stayed down and released the one-active-conversation lease");
  } finally {
    await Promise.all(servers.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});

test("grant metadata stays scoped: agents see only usable grants while humans manage every home-project profile", { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-grant-visibility-"));
  const servers: ChildProcess[] = [];
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    servers.push(await startDevNode(environment, node));
    const auth = await signIn(environment, node);
    const project = node.projects[0];
    const otherProject = node.projects[1];
    const mine = randomUUID(), theirs = randomUUID(), uninvolved = randomUUID();
    const profileId = await createProfile(node, environment, project.id, "Shared bank login");
    const grantCall = (query: URLSearchParams, body: unknown) => api<AccessReply>(node, auth, "PUT", `/browser/profiles/${profileId}/access?${query}`, body);
    // The profile is granted to this conversation, another conversation of the
    // same project, and a whole other project.
    assert.equal((await grantCall(new URLSearchParams({ projectId: project.id, conversationId: mine }), { grant: { scope: "conversation", projectId: project.id, conversationId: mine } })).status, 200);
    assert.equal((await grantCall(new URLSearchParams({ projectId: project.id, conversationId: mine }), { grant: { scope: "conversation", projectId: project.id, conversationId: theirs } })).status, 200);
    assert.equal((await grantCall(new URLSearchParams({ projectId: project.id, conversationId: mine }), { grant: { scope: "project", projectId: otherProject.id } })).status, 200);

    // The agent of one granted conversation sees the profile — but only the
    // grant its own conversation can use. Assignments naming other
    // conversations or other projects are not its metadata to read.
    const agent = await issueAgentToken(node, environment, project.id, mine);
    const agentProfiles = async () => JSON.parse(await (await fetch(agent.url, {
      method: "POST", headers: { Authorization: `Bearer ${agent.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "profiles" }), signal: AbortSignal.timeout(30000),
    })).text()) as ProfilesReply;
    const listing = await agentProfiles();
    assert.deepEqual(listing.profiles.map(profile => profile.id), [profileId]);
    assert.deepEqual((listing.profiles[0].grants ?? []).map(({ scope, projectId, conversationId }) => ({ scope, projectId, conversationId })), [{ scope: "conversation", projectId: project.id, conversationId: mine }], "an agent's listing carries only its own usable grant");
    assert.equal(JSON.stringify(listing).includes(theirs), false, "another conversation's id never reaches the agent listing");
    assert.equal(JSON.stringify(listing).includes(otherProject.id), false, "another project's grant never reaches the agent listing");

    // The local human lists the home project from an ungranted conversation and
    // still gets every home-project profile with its full grant list, so Access
    // management stays possible for assignments it holds no grant for.
    const humanView = await api<ProfilesReply>(node, auth, "GET", `/browser/profiles?${new URLSearchParams({ projectId: project.id, conversationId: uninvolved })}`);
    assert.deepEqual(humanView.body.profiles.map(profile => profile.id), [profileId], "a home-project profile granted only to other conversations stays manageable by the local human");
    assert.equal(humanView.body.profiles[0].grants!.length, 3, "the human sees the full grant list to manage");
    const revoked = await grantCall(new URLSearchParams({ projectId: project.id, conversationId: uninvolved }), { revoke: { scope: "conversation", projectId: project.id, conversationId: theirs } });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal(revoked.body.profile.grants!.length, 2, "management from the ungranted conversation's view revokes the other conversation's assignment");

    // Widening human management grants agents nothing: the ungranted
    // conversation's agent still sees no profile, and the granted one is
    // untouched — still exactly its own single grant.
    const strangerAgent = await issueAgentToken(node, environment, project.id, uninvolved);
    const strangerList = JSON.parse(await (await fetch(strangerAgent.url, {
      method: "POST", headers: { Authorization: `Bearer ${strangerAgent.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "profiles" }), signal: AbortSignal.timeout(30000),
    })).text()) as ProfilesReply;
    assert.equal(strangerList.profiles.length, 0, "the human's management view does not widen agent access");
    const relisted = await agentProfiles();
    assert.deepEqual(relisted.profiles.map(profile => profile.id), [profileId]);
    assert.deepEqual((relisted.profiles[0].grants ?? []).map(({ scope, projectId, conversationId }) => ({ scope, projectId, conversationId })), [{ scope: "conversation", projectId: project.id, conversationId: mine }], "the granted agent's metadata stays limited to its own grant");
  } finally {
    await Promise.all(servers.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
