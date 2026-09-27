// Succession of a machine that is gone for good. Its twin takes over what it owned.
// The dual-signed twin certificate is the proof: the lost machine itself signed that
// it trusts this twin with all its data, so other members accept the twin as the new
// owner of the lost machine's resources — and nobody else.
import type { DatabaseSync } from "node:sqlite";
import { pinnedClusterPublicKey } from "./cluster-identity.js";
import { verifyTwinCertificate, type TwinCertificate } from "./cluster-twins.js";

export function ensureSuccessionSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS cluster_v2_successions(lost_node_id TEXT PRIMARY KEY, successor_node_id TEXT NOT NULL, relationship_id TEXT NOT NULL, certificate TEXT NOT NULL, recorded_at TEXT NOT NULL)`);
}

/** The successor a certificate proves for `lostNodeId`. Both participants' keys must be
    the keys this node already pinned for them. */
export function verifiedSuccessor(db: DatabaseSync, lostNodeId: string, value: unknown): { successor: string; certificate: TwinCertificate } {
  const certificate = verifyTwinCertificate(value);
  const { inviter, acceptor } = certificate.body;
  const [lost, successor] = inviter.nodeId === lostNodeId ? [inviter, acceptor] : acceptor.nodeId === lostNodeId ? [acceptor, inviter] : [undefined, undefined];
  if (!lost || !successor) throw new Error("The twin certificate does not name the lost machine");
  if (pinnedClusterPublicKey(db, lost.nodeId) !== lost.publicKey || pinnedClusterPublicKey(db, successor.nodeId) !== successor.publicKey) {
    throw new Error("The twin certificate keys do not match the known machines");
  }
  return { successor: successor.nodeId, certificate };
}

export function successorOf(db: DatabaseSync, lostNodeId: string): string | undefined {
  ensureSuccessionSchema(db);
  return (db.prepare("SELECT successor_node_id FROM cluster_v2_successions WHERE lost_node_id=?").get(lostNodeId) as { successor_node_id: string } | undefined)?.successor_node_id;
}

/** Records the succession and moves ownership of the lost machine's resources to the
    successor. The lost machine's policy contexts are dropped; the successor reissues
    them. Returns the moved resources. A second call with the same successor is a no-op. */
export function recordSuccession(db: DatabaseSync, lostNodeId: string, successorNodeId: string, certificate: TwinCertificate): Array<{ kind: "project" | "secret"; id: string }> {
  ensureSuccessionSchema(db);
  const existing = successorOf(db, lostNodeId);
  if (existing === successorNodeId) return [];
  if (existing) throw new Error("The lost machine already has a different successor");
  db.prepare("INSERT INTO cluster_v2_successions VALUES(?,?,?,?,?)").run(lostNodeId, successorNodeId, certificate.body.relationshipId, JSON.stringify(certificate), new Date().toISOString());
  const moved = db.prepare("SELECT kind,resource_id id FROM cluster_v2_resource_policy WHERE owner_node_id=? AND deleted=0").all(lostNodeId) as unknown as Array<{ kind: "project" | "secret"; id: string }>;
  db.prepare("UPDATE cluster_v2_resource_policy SET owner_node_id=? WHERE owner_node_id=?").run(successorNodeId, lostNodeId);
  db.prepare("UPDATE sharing_resource_owners SET owner_node_id=? WHERE owner_node_id=?").run(successorNodeId, lostNodeId);
  db.prepare("DELETE FROM cluster_v2_resource_contexts WHERE json_extract(statement,'$.body.ownerNodeId')=?").run(lostNodeId);
  return moved;
}
