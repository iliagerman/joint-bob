import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  acceptMembershipManagerTransfer, applyMembershipSnapshot, commitMembershipManagerTransfer,
  createMembershipCluster, createMembershipInvitation, listManagerTransferDeliveries,
  prepareMembershipJoin, prepareMembershipManagerTransfer, redeemMembershipInvitation,
} from "../src/cluster-membership.js";
import { clusterPublicKeyFingerprint } from "../src/cluster-identity.js";
import { acknowledgeManagerCertificate } from "../src/server/cluster-manager.js";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003";
const CLUSTER = "10000000-0000-4000-8000-000000000001";
const TRANSFER = "30000000-0000-4000-8000-000000000001";

function count(db: DatabaseSync, table: string, peer: string): number {
  return (db.prepare(`SELECT count(*) AS count FROM ${table} WHERE cluster_id=? AND peer_id=?`).get(CLUSTER, peer) as { count: number }).count;
}

test("certificate acknowledgement atomically removes only covered membership deliveries", () => {
  const a = new DatabaseSync(":memory:");
  const b = new DatabaseSync(":memory:");
  try {
    const localA = { nodeId: A, name: "Alpha", url: "http://127.0.0.1:4001" };
    const localB = { nodeId: B, name: "Beta", url: "http://127.0.0.1:4002" };
    createMembershipCluster(a, localA, { id: CLUSTER, name: "Team" });
    const invitation = createMembershipInvitation(a, A, A, CLUSTER, 1, 1_000);
    const request = prepareMembershipJoin(b, localB, invitation, clusterPublicKeyFingerprint(invitation.body.manager.publicKey), "20000000-0000-4000-8000-000000000002", 1_000);
    const joined = redeemMembershipInvitation(a, A, request, invitation.secret, 1_000);
    applyMembershipSnapshot(b, B, joined);
    const offer = prepareMembershipManagerTransfer(a, A, CLUSTER, B, 1, TRANSFER);
    const acceptance = acceptMembershipManagerTransfer(b, B, offer);
    const certificate = commitMembershipManagerTransfer(a, A, acceptance);
    const delivery = listManagerTransferDeliveries(a).find((item) => item.peerId === B)!;
    const coveredRevision = certificate.acceptance.snapshot.body.revision;
    a.prepare("INSERT OR REPLACE INTO cluster_v2_membership_deliveries VALUES(?,?,?,?,?)")
      .run(CLUSTER, B, localB.url, coveredRevision + 1, JSON.stringify(joined));
    a.prepare("INSERT OR REPLACE INTO cluster_v2_membership_deliveries VALUES(?,?,?,?,?)")
      .run(CLUSTER, C, "http://127.0.0.1:4003", coveredRevision, JSON.stringify(joined));

    a.exec("CREATE TRIGGER fail_ack_delete BEFORE DELETE ON cluster_v2_membership_deliveries BEGIN SELECT RAISE(ABORT,'fixture ack failure'); END");
    assert.throws(() => acknowledgeManagerCertificate(a, delivery), /fixture ack failure/);
    assert.equal(count(a, "cluster_v2_manager_deliveries", B), 1);
    assert.equal(count(a, "cluster_v2_membership_deliveries", B), 2);

    a.exec("DROP TRIGGER fail_ack_delete");
    acknowledgeManagerCertificate(a, delivery);
    assert.equal(count(a, "cluster_v2_manager_deliveries", B), 0);
    const remaining = a.prepare("SELECT peer_id,revision FROM cluster_v2_membership_deliveries ORDER BY peer_id,revision").all()
      .map((row) => ({ ...(row as { peer_id: string; revision: number }) }));
    assert.deepEqual(remaining, [
      { peer_id: B, revision: coveredRevision + 1 },
      { peer_id: C, revision: coveredRevision },
    ]);
  } finally {
    a.close();
    b.close();
  }
});
