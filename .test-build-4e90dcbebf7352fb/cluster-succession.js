import { pinnedClusterPublicKey } from "./cluster-identity.js";
import { verifyTwinCertificate } from "./cluster-twins.js";
function ensureSuccessionSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS cluster_v2_successions(lost_node_id TEXT PRIMARY KEY, successor_node_id TEXT NOT NULL, relationship_id TEXT NOT NULL, certificate TEXT NOT NULL, recorded_at TEXT NOT NULL)`);
}
function verifiedSuccessor(db, lostNodeId, value) {
  const certificate = verifyTwinCertificate(value);
  const { inviter, acceptor } = certificate.body;
  const [lost, successor] = inviter.nodeId === lostNodeId ? [inviter, acceptor] : acceptor.nodeId === lostNodeId ? [acceptor, inviter] : [void 0, void 0];
  if (!lost || !successor) throw new Error("The twin certificate does not name the lost machine");
  if (pinnedClusterPublicKey(db, lost.nodeId) !== lost.publicKey || pinnedClusterPublicKey(db, successor.nodeId) !== successor.publicKey) {
    throw new Error("The twin certificate keys do not match the known machines");
  }
  return { successor: successor.nodeId, certificate };
}
function successorOf(db, lostNodeId) {
  ensureSuccessionSchema(db);
  return db.prepare("SELECT successor_node_id FROM cluster_v2_successions WHERE lost_node_id=?").get(lostNodeId)?.successor_node_id;
}
function recordSuccession(db, lostNodeId, successorNodeId, certificate) {
  ensureSuccessionSchema(db);
  const existing = successorOf(db, lostNodeId);
  if (existing === successorNodeId) return [];
  if (existing) throw new Error("The lost machine already has a different successor");
  db.prepare("INSERT INTO cluster_v2_successions VALUES(?,?,?,?,?)").run(lostNodeId, successorNodeId, certificate.body.relationshipId, JSON.stringify(certificate), (/* @__PURE__ */ new Date()).toISOString());
  const moved = db.prepare("SELECT kind,resource_id id FROM cluster_v2_resource_policy WHERE owner_node_id=? AND deleted=0").all(lostNodeId);
  db.prepare("UPDATE cluster_v2_resource_policy SET owner_node_id=? WHERE owner_node_id=?").run(successorNodeId, lostNodeId);
  db.prepare("UPDATE sharing_resource_owners SET owner_node_id=? WHERE owner_node_id=?").run(successorNodeId, lostNodeId);
  db.prepare("DELETE FROM cluster_v2_resource_contexts WHERE json_extract(statement,'$.body.ownerNodeId')=?").run(lostNodeId);
  return moved;
}
export {
  ensureSuccessionSchema,
  recordSuccession,
  successorOf,
  verifiedSuccessor
};
