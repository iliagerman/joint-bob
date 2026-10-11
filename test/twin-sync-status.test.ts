import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getClusterNode } from "../src/cluster.js";
import { setTrustedTwin } from "../src/cluster-sharing-policy.js";
import { applyTwinCertificate, confirmTwinAcceptance, createTwinInvitation, prepareTwinAcceptance } from "../src/cluster-twins.js";
import { clusterV2Database } from "../src/cluster-v2-store.js";
import { sharedTranscriptStatus } from "../src/server/shared-transcripts.js";
import { addProject, removeProject } from "../src/store.js";

test("twin transcript errors name all affected shared projects without leaking unrelated errors", async () => {
  const local = await getClusterNode(), db = await clusterV2Database(), peer = randomUUID();
  setTrustedTwin(db, local.id, peer, true);
  const first = await addProject("Contigos", path.join(os.homedir(), randomUUID()));
  const second = await addProject("Dak-Live", path.join(os.homedir(), randomUUID()));
  sharedTranscriptStatus(db, local.id, peer);
  const save = db.prepare("INSERT INTO cluster_v2_transcript_errors VALUES(?,?,?)");
  save.run(peer, first.id, "aborted");
  save.run(peer, second.id, "Cluster peer is unreachable");
  save.run(peer, "unshared-project", "Private project failure");
  const status = sharedTranscriptStatus(db, local.id, peer);
  assert.match(status.error ?? "", /Contigos: aborted/, "error identifies the affected project, not just 'aborted'");
  assert.match(status.error ?? "", /Dak-Live: Cluster peer is unreachable/, "one project must not hide the other failure");
  assert.doesNotMatch(status.error ?? "", /Private project failure/);
  db.prepare("DELETE FROM cluster_v2_transcript_errors WHERE project_id IN (?,?)").run(first.id, second.id);
  assert.equal(sharedTranscriptStatus(db, local.id, peer).error, undefined, "resolved errors disappear while unrelated errors stay private");
});

test("missing native project is not pending and cannot keep a transcript error", async () => {
  const local = await getClusterNode(), db = await clusterV2Database(), peer = randomUUID();
  setTrustedTwin(db, local.id, peer, true);
  const baselinePending = sharedTranscriptStatus(db, local.id, peer).pending;
  const project = await addProject("orphaned native row", path.join(os.homedir(), randomUUID()));
  sharedTranscriptStatus(db, local.id, peer);
  db.prepare("INSERT INTO cluster_v2_transcript_errors VALUES(?,?,?)").run(peer, project.id, "unreachable");
  db.prepare("INSERT INTO cluster_v2_transcript_progress VALUES(?,?)").run(peer, project.id);
  db.prepare("DELETE FROM projects WHERE id=?").run(project.id);
  const status = sharedTranscriptStatus(db, local.id, peer);
  assert.equal(status.pending, baselinePending);
  assert.equal(status.error, undefined);
  assert.equal(db.prepare("SELECT 1 FROM cluster_v2_transcript_errors WHERE project_id=?").get(project.id), undefined);
  assert.equal(db.prepare("SELECT 1 FROM cluster_v2_transcript_progress WHERE project_id=?").get(project.id), undefined);
  assert.equal((db.prepare("SELECT deleted FROM cluster_v2_resource_policy WHERE resource_id=?").get(project.id) as {deleted:number}).deleted, 0, "status must not sign an owner deletion");
});

test("owner deletion retires shared policy and stale transcript state without deleting files", async () => {
  const local = await getClusterNode(), db = await clusterV2Database(), peer = randomUUID();
  const remote = new (await import("node:sqlite")).DatabaseSync(":memory:");
  const invite = createTwinInvitation(db, local.id);
  const acceptance = prepareTwinAcceptance(remote, peer, invite, invite.body.inviter.fingerprint);
  applyTwinCertificate(remote, peer, confirmTwinAcceptance(db, local.id, acceptance, invite.secret));
  const project = await addProject("Deleted twin", path.join(os.homedir(), randomUUID()));
  const { mkdir, writeFile, readFile, rm } = await import("node:fs/promises");
  const file = path.join(project.path, "source.txt");
  await mkdir(project.path, { recursive: true });
  await writeFile(file, "keep me");
  sharedTranscriptStatus(db, local.id, peer);
  db.prepare("INSERT INTO cluster_v2_transcript_errors VALUES(?,?,?)").run(peer, project.id, "Cluster peer is unreachable");
  db.prepare("INSERT INTO cluster_v2_transcript_progress VALUES(?,?)").run(peer, project.id);
  const alias = `alias-${randomUUID()}`;
  db.prepare("INSERT INTO project_aliases(alias_id,project_id,created_at) VALUES(?,?,?)").run(alias, project.id, new Date().toISOString());
  try {
    await removeProject(alias);
    const policy = db.prepare("SELECT generation,deleted FROM cluster_v2_resource_policy WHERE kind='project' AND resource_id=?").get(project.id) as {generation:number;deleted:number};
    assert.equal(policy.deleted, 1);
    assert.equal(policy.generation, 2);
    assert.ok(db.prepare("SELECT 1 FROM cluster_v2_resource_deletions WHERE kind='project' AND resource_id=?").get(project.id));
    assert.ok(db.prepare("SELECT 1 FROM cluster_v2_resource_deliveries WHERE kind='project' AND resource_id=? AND json_extract(statement,'$.body.operation')='delete'").get(project.id));
    assert.equal(db.prepare("SELECT 1 FROM projects WHERE id=?").get(project.id), undefined);
    assert.equal(await readFile(file, "utf8"), "keep me");
    assert.equal(db.prepare("SELECT 1 FROM cluster_v2_transcript_errors WHERE project_id=?").get(project.id), undefined);
    assert.equal(db.prepare("SELECT 1 FROM cluster_v2_transcript_progress WHERE project_id=?").get(project.id), undefined);
    assert.doesNotMatch(sharedTranscriptStatus(db, local.id, peer).error ?? "", /Deleted twin/);
    await removeProject(project.id);
    assert.equal((db.prepare("SELECT generation FROM cluster_v2_resource_policy WHERE kind='project' AND resource_id=?").get(project.id) as {generation:number}).generation, 2);
  } finally { remote.close(); await rm(project.path, { recursive: true, force: true }); }
});
