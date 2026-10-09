import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getClusterNode } from "../src/cluster.js";
import { setTrustedTwin } from "../src/cluster-sharing-policy.js";
import { clusterV2Database } from "../src/cluster-v2-store.js";
import { sharedTranscriptStatus } from "../src/server/shared-transcripts.js";
import { addProject } from "../src/store.js";

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
