import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { agentResourcePaths } from "../src/agent-resources.js";
import { getOrCreateClusterIdentity } from "../src/cluster-identity.js";
import { defaultRelayResourceSettings, emptyRelayEnabledResources, publishRelayPolicy } from "../src/relay/resource-policy.js";
import { fetchRelaySkillBundle, serveSkillBundle } from "../src/relay/skill-bundle.js";
import { admitMachine, createMembership, updateMembership } from "../src/relay/store.js";
import { buildSkillBundle } from "../src/skill-sharing.js";

const NAME = "relay-delivery-fixture";

test("an admitted machine downloads only the skills the relay enforces, verified against the signed digest", async () => {
  const relayDb = new DatabaseSync(":memory:"), followerDb = new DatabaseSync(":memory:");
  const relayId = randomUUID(), followerId = randomUUID();
  const relayIdentity = getOrCreateClusterIdentity(relayDb, relayId);
  const followerIdentity = getOrCreateClusterIdentity(followerDb, followerId);
  const directory = path.join(agentResourcePaths().sharedSkills, NAME);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${NAME}\ndescription: Delivered by a relay\n---\nBody\n`);
  const { digest } = await buildSkillBundle(directory, NAME);
  const settings = defaultRelayResourceSettings();
  const enabled = emptyRelayEnabledResources();
  enabled.skills.claude.push(NAME);
  const server = http.createServer((request, response) => void serveSkillBundle(relayDb, relayId, request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const membership = createMembership(followerDb, origin, relayIdentity.fingerprint);
    updateMembership(followerDb, membership.id, { status: "admitted", relayNodeId: relayId, fingerprint: relayIdentity.fingerprint });
    const relay = { ...membership, status: "admitted" as const, relayNodeId: relayId };

    await assert.rejects(fetchRelaySkillBundle(followerDb, followerId, relay, NAME, digest), /403/, "an unknown machine is refused");
    admitMachine(relayDb, followerId, followerIdentity.publicKey, "follower", "test");

    publishRelayPolicy(relayDb, relayId, [], { settings, enabled, skillDigests: { [NAME]: digest } });
    await assert.rejects(fetchRelaySkillBundle(followerDb, followerId, relay, NAME, digest), /404/, "nothing is served until the relay enforces");

    settings.skills.enforce = true;
    publishRelayPolicy(relayDb, relayId, [], { settings, enabled, skillDigests: { [NAME]: digest } });
    const bundle = await fetchRelaySkillBundle(followerDb, followerId, relay, NAME, digest) as { files: Array<{ path: string }> };
    assert.ok(bundle.files.some((file) => file.path === "SKILL.md"));
    await assert.rejects(fetchRelaySkillBundle(followerDb, followerId, relay, "not-enforced", digest), /404/, "only listed skills are served");
    await assert.rejects(fetchRelaySkillBundle(followerDb, followerId, relay, NAME, "0".repeat(64)), /signed digest|409/, "a wrong digest is never accepted");

    await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${NAME}\ndescription: Changed\n---\nBody\n`);
    await assert.rejects(fetchRelaySkillBundle(followerDb, followerId, relay, NAME, digest), /409/, "an edit after publishing waits for the next policy");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
    relayDb.close(); followerDb.close();
  }
});

test("a connected node installs enforced skills as relay-managed without opting in and removes them when it leaves the relay", async () => {
  const { clusterV2Database } = await import("../src/cluster-v2-store.js");
  const { getClusterNode } = await import("../src/cluster.js");
  const { receiveRelayPolicy, relayPolicySubscriptions } = await import("../src/relay/resource-policy.js");
  const { syncRelaySkills, relayOwnerId } = await import("../src/server/skill-sharing.js");
  const { listReceivedSkills } = await import("../src/skill-sharing.js");
  const { receivedOwner } = await import("../src/skill-sharing-files.js");
  const { mkdtemp } = await import("node:fs/promises");
  const os = await import("node:os");
  const db = await clusterV2Database();
  getOrCreateClusterIdentity(db, (await getClusterNode()).id);
  const relayDb = new DatabaseSync(":memory:");
  const relayId = randomUUID();
  const relayIdentity = getOrCreateClusterIdentity(relayDb, relayId);
  const source = await mkdtemp(path.join(os.tmpdir(), "relay-source-"));
  const sourceSkill = path.join(source, NAME);
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), `---\nname: ${NAME}\ndescription: Delivered by a relay\n---\nBody\n`);
  await writeFile(path.join(sourceSkill, "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  const built = await buildSkillBundle(sourceSkill, NAME);
  const server = http.createServer((_request, response) => { response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ name: NAME, digest: built.digest, bundle: built.bundle })); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const destination = path.join(agentResourcePaths().sharedSkills, NAME);
  const membership = createMembership(db, origin, relayIdentity.fingerprint);
  try {
    updateMembership(db, membership.id, { status: "admitted", relayNodeId: relayId, fingerprint: relayIdentity.fingerprint });
    const settings = defaultRelayResourceSettings();
    settings.skills.enforce = true;
    const enabled = emptyRelayEnabledResources();
    enabled.skills.pi.push(NAME);
    const statement = publishRelayPolicy(relayDb, relayId, [], { settings, enabled, skillDigests: { [NAME]: built.digest } });
    const admitted = { ...membership, status: "admitted" as const, relayNodeId: relayId, fingerprint: relayIdentity.fingerprint };
    assert.equal(receiveRelayPolicy(db, admitted, relayIdentity.publicKey, statement), true);

    assert.equal(await syncRelaySkills(), true, JSON.stringify(db.prepare("SELECT * FROM skill_peer_status").all()));
    const owner = relayOwnerId(relayId);
    assert.equal(await receivedOwner(agentResourcePaths().sharedSkills, NAME), owner);
    assert.equal(listReceivedSkills(db).find((item) => item.name === NAME)?.ownerNodeId, owner);
    assert.ok((await buildSkillBundle(destination, NAME)).digest === built.digest, "installed files match the signed digest");
    assert.equal(await syncRelaySkills(), false, "an unchanged policy installs nothing again");
    assert.equal(relayPolicySubscriptions(db).find((item) => item.relay.id === membership.id)?.statement?.body.version, statement.body.version);

    updateMembership(db, membership.id, { status: "revoked" });
    assert.equal(await syncRelaySkills(), true, "leaving the relay removes what it delivered");
    assert.equal(listReceivedSkills(db).some((item) => item.name === NAME), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.prepare("DELETE FROM relay_skill_subscriptions WHERE membership_id=?").run(membership.id);
    db.prepare("DELETE FROM relay_memberships WHERE id=?").run(membership.id);
    await rm(destination, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
    relayDb.close();
  }
});

test("the relay's copy wins over a local skill or a local edit under the same name", async () => {
  const { clusterV2Database } = await import("../src/cluster-v2-store.js");
  const { getClusterNode } = await import("../src/cluster.js");
  const { receiveRelayPolicy } = await import("../src/relay/resource-policy.js");
  const { syncRelaySkills, relayOwnerId } = await import("../src/server/skill-sharing.js");
  const { receivedOwner } = await import("../src/skill-sharing-files.js");
  const { mkdtemp, readFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const db = await clusterV2Database();
  getOrCreateClusterIdentity(db, (await getClusterNode()).id);
  const relayDb = new DatabaseSync(":memory:");
  const relayId = randomUUID();
  const relayIdentity = getOrCreateClusterIdentity(relayDb, relayId);
  const source = await mkdtemp(path.join(os.tmpdir(), "relay-wins-"));
  const sourceSkill = path.join(source, NAME);
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), `---\nname: ${NAME}\ndescription: Relay version\n---\nRelay\n`);
  const built = await buildSkillBundle(sourceSkill, NAME);
  const server = http.createServer((_request, response) => { response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ name: NAME, digest: built.digest, bundle: built.bundle })); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const destination = path.join(agentResourcePaths().sharedSkills, NAME);
  const membership = createMembership(db, `http://127.0.0.1:${(server.address() as AddressInfo).port}`, relayIdentity.fingerprint);
  try {
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, "SKILL.md"), `---\nname: ${NAME}\ndescription: Local version\n---\nLocal\n`);
    updateMembership(db, membership.id, { status: "admitted", relayNodeId: relayId, fingerprint: relayIdentity.fingerprint });
    const settings = defaultRelayResourceSettings();
    settings.skills.enforce = true;
    const enabled = emptyRelayEnabledResources();
    enabled.skills.claude.push(NAME);
    const statement = publishRelayPolicy(relayDb, relayId, [], { settings, enabled, skillDigests: { [NAME]: built.digest } });
    receiveRelayPolicy(db, { ...membership, status: "admitted", relayNodeId: relayId, fingerprint: relayIdentity.fingerprint }, relayIdentity.publicKey, statement);
    assert.equal(await syncRelaySkills(), true, JSON.stringify(db.prepare("SELECT * FROM skill_peer_status").all()));
    assert.match(await readFile(path.join(destination, "SKILL.md"), "utf8"), /Relay version/, "the local skill is replaced");
    assert.equal(await receivedOwner(agentResourcePaths().sharedSkills, NAME), relayOwnerId(relayId));

    await writeFile(path.join(destination, "SKILL.md"), `---\nname: ${NAME}\ndescription: Edited here\n---\nEdited\n`);
    assert.equal(await syncRelaySkills(), true);
    assert.match(await readFile(path.join(destination, "SKILL.md"), "utf8"), /Relay version/, "a local edit is overwritten on the next sync");

    updateMembership(db, membership.id, { status: "revoked" });
    assert.equal(await syncRelaySkills(), true);
    assert.match(await readFile(path.join(destination, "SKILL.md"), "utf8"), /Local version/, "leaving the relay restores this node's own skill");
    const { unavailableSkillNames } = await import("../src/scoped-skills.js");
    assert.equal(unavailableSkillNames().includes(NAME), false, "the restored skill is available to agents again");
    assert.equal(await receivedOwner(agentResourcePaths().sharedSkills, NAME), undefined);
  } finally {
    updateMembership(db, membership.id, { status: "revoked" });
    await syncRelaySkills().catch(() => false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.prepare("DELETE FROM relay_skill_subscriptions WHERE membership_id=?").run(membership.id);
    db.prepare("DELETE FROM relay_memberships WHERE id=?").run(membership.id);
    await rm(destination, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
    relayDb.close();
  }
});

test("an enforced skill replaces every other copy with its name for the agents it is enforced for", async () => {
  const { clusterV2Database } = await import("../src/cluster-v2-store.js");
  const { getClusterNode } = await import("../src/cluster.js");
  const { receiveRelayPolicy } = await import("../src/relay/resource-policy.js");
  const { activationDecision, relayDeliveredSkill } = await import("../src/resource-activation.js");
  const { syncRelaySkills } = await import("../src/server/skill-sharing.js");
  const { mkdtemp, readFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const db = await clusterV2Database();
  getOrCreateClusterIdentity(db, (await getClusterNode()).id);
  const relayDb = new DatabaseSync(":memory:");
  const relayId = randomUUID();
  const relayIdentity = getOrCreateClusterIdentity(relayDb, relayId);
  const source = await mkdtemp(path.join(os.tmpdir(), "relay-replace-"));
  const sourceSkill = path.join(source, NAME);
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), `---\nname: ${NAME}\ndescription: Relay\n---\nRelay\n`);
  const built = await buildSkillBundle(sourceSkill, NAME);
  const server = http.createServer((_request, response) => { response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ name: NAME, digest: built.digest, bundle: built.bundle })); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const membership = createMembership(db, `http://127.0.0.1:${(server.address() as AddressInfo).port}`, relayIdentity.fingerprint);
  const managed = path.join(agentResourcePaths().sharedSkills, NAME);
  try {
    updateMembership(db, membership.id, { status: "admitted", relayNodeId: relayId, fingerprint: relayIdentity.fingerprint });
    const settings = defaultRelayResourceSettings();
    settings.skills.enforce = true;
    const enabled = emptyRelayEnabledResources();
    enabled.skills.pi.push(NAME);
    const statement = publishRelayPolicy(relayDb, relayId, [], { settings, enabled, skillDigests: { [NAME]: built.digest } });
    receiveRelayPolicy(db, { ...membership, status: "admitted", relayNodeId: relayId, fingerprint: relayIdentity.fingerprint }, relayIdentity.publicKey, statement);
    assert.equal(await syncRelaySkills(), true);
    assert.equal(relayDeliveredSkill(NAME), true);
    assert.equal(activationDecision("skill", NAME, "pi", true, true).enabled, true, "the relay's copy loads");
    assert.match(activationDecision("skill", NAME, "pi", false).reason, /^Replaced by relay: /, "a native copy is replaced");
    assert.equal(activationDecision("skill", NAME, "pi", false).enabled, false);
    assert.equal(activationDecision("skill", NAME, "pi", true).enabled, false, "a cluster or scoped copy is replaced too");
    assert.equal(activationDecision("skill", NAME, "kiro", false).enabled, true, "kiro is not enforced, so the local decision stands");
    updateMembership(db, membership.id, { status: "revoked" });
    assert.equal(await syncRelaySkills(), true);
    assert.equal(activationDecision("skill", NAME, "pi", false).enabled, true, "leaving the relay returns the local decision");
    assert.equal(await readFile(path.join(managed, "SKILL.md"), "utf8").then(() => true, () => false), false, "syncRelaySkills removes the delivered copy");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    updateMembership(db, membership.id, { status: "revoked" });
    await syncRelaySkills().catch(() => false);
    db.prepare("DELETE FROM relay_skill_subscriptions WHERE membership_id=?").run(membership.id);
    db.prepare("DELETE FROM relay_memberships WHERE id=?").run(membership.id);
    await rm(managed, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
    relayDb.close();
  }
});

test("a policy without delivered skills keeps its old shape, so machines on older releases still accept it", () => {
  const relayDb = new DatabaseSync(":memory:");
  const relayId = randomUUID();
  getOrCreateClusterIdentity(relayDb, relayId);
  try {
    const statement = publishRelayPolicy(relayDb, relayId, [], { settings: defaultRelayResourceSettings(), enabled: emptyRelayEnabledResources(), skillDigests: {} });
    assert.equal("skillDigests" in JSON.parse(JSON.stringify(statement.body)), false);
  } finally { relayDb.close(); }
});

test("local copies keep working until the relay's copy arrives, and an edited relay copy stays as a local skill after leaving the relay", async () => {
  const { clusterV2Database } = await import("../src/cluster-v2-store.js");
  const { getClusterNode } = await import("../src/cluster.js");
  const { receiveRelayPolicy } = await import("../src/relay/resource-policy.js");
  const { activationDecision } = await import("../src/resource-activation.js");
  const { syncRelaySkills } = await import("../src/server/skill-sharing.js");
  const { listReceivedSkills } = await import("../src/skill-sharing.js");
  const { receivedOwner } = await import("../src/skill-sharing-files.js");
  const { mkdtemp, readFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const db = await clusterV2Database();
  getOrCreateClusterIdentity(db, (await getClusterNode()).id);
  const relayDb = new DatabaseSync(":memory:");
  const relayId = randomUUID();
  const relayIdentity = getOrCreateClusterIdentity(relayDb, relayId);
  const source = await mkdtemp(path.join(os.tmpdir(), "relay-release-"));
  const sourceSkill = path.join(source, NAME);
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), `---\nname: ${NAME}\ndescription: Relay\n---\nRelay\n`);
  const built = await buildSkillBundle(sourceSkill, NAME);
  let reachable = false;
  const server = http.createServer((_request, response) => {
    if (!reachable) { response.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "down" })); return; }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ name: NAME, digest: built.digest, bundle: built.bundle }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const membership = createMembership(db, `http://127.0.0.1:${(server.address() as AddressInfo).port}`, relayIdentity.fingerprint);
  const managed = path.join(agentResourcePaths().sharedSkills, NAME);
  try {
    updateMembership(db, membership.id, { status: "admitted", relayNodeId: relayId, fingerprint: relayIdentity.fingerprint });
    const settings = defaultRelayResourceSettings();
    settings.skills.enforce = true;
    const enabled = emptyRelayEnabledResources();
    enabled.skills.pi.push(NAME);
    const statement = publishRelayPolicy(relayDb, relayId, [], { settings, enabled, skillDigests: { [NAME]: built.digest } });
    receiveRelayPolicy(db, { ...membership, status: "admitted", relayNodeId: relayId, fingerprint: relayIdentity.fingerprint }, relayIdentity.publicKey, statement);

    assert.equal(await syncRelaySkills(), false, "the download failed");
    assert.match(String((db.prepare("SELECT last_error FROM skill_peer_status WHERE owner_node_id=?").get(`relay:${relayId}`) as { last_error: string | null }).last_error), /503/);
    assert.equal(activationDecision("skill", NAME, "pi", false).enabled, true, "a native copy still loads while the relay's copy is missing");

    reachable = true;
    assert.equal(await syncRelaySkills(), true);
    assert.equal(activationDecision("skill", NAME, "pi", false).enabled, false, "once delivered, the relay's copy replaces it");

    await writeFile(path.join(managed, "SKILL.md"), `---\nname: ${NAME}\ndescription: Edited here\n---\nEdited\n`);
    updateMembership(db, membership.id, { status: "revoked" });
    assert.equal(await syncRelaySkills(), true);
    assert.match(await readFile(path.join(managed, "SKILL.md"), "utf8"), /Edited here/, "the edited copy is kept");
    assert.equal(await receivedOwner(agentResourcePaths().sharedSkills, NAME), undefined, "and is now this node's own skill");
    assert.equal(listReceivedSkills(db).some((item) => item.name === NAME), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    updateMembership(db, membership.id, { status: "revoked" });
    await syncRelaySkills().catch(() => false);
    db.prepare("DELETE FROM skill_peer_status WHERE owner_node_id=?").run(`relay:${relayId}`);
    db.prepare("DELETE FROM relay_skill_subscriptions WHERE membership_id=?").run(membership.id);
    db.prepare("DELETE FROM relay_memberships WHERE id=?").run(membership.id);
    await rm(managed, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
    relayDb.close();
  }
});
