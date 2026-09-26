import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { SignedMembershipSnapshot } from "./cluster-membership.js";

const uuid = z.string().uuid().regex(/^[0-9a-f-]+$/);
const endpointSchema = z.object({
  nodeId: uuid,
  name: z.string().trim().min(1).max(80),
  url: z.string().transform((value, context) => {
    try {
      const parsed = new URL(value);
      const loopback = parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
      if ((parsed.protocol !== "https:" && !loopback) || parsed.username || parsed.password
        || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error();
      return parsed.origin;
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid peer endpoint" });
      return z.NEVER;
    }
  }),
}).strict();

export type PeerEndpoint = z.infer<typeof endpointSchema>;
export type PeerEndpointContext = { kind: "cluster" | "twin"; id: string };

export function ensurePeerEndpointSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS cluster_v2_peer_endpoints(
    context_kind TEXT NOT NULL CHECK(context_kind IN ('cluster','twin')),
    context_id TEXT NOT NULL,node_id TEXT NOT NULL,name TEXT NOT NULL,url TEXT NOT NULL,
    PRIMARY KEY(context_kind,context_id,node_id));
    CREATE TABLE IF NOT EXISTS cluster_v2_peer_activity(node_id TEXT PRIMARY KEY,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,last_seen_at TEXT);
    INSERT OR IGNORE INTO cluster_v2_peer_activity
      SELECT node_id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL FROM cluster_v2_peer_endpoints;`);
}

export function recordPeerEndpoint(db: DatabaseSync, context: PeerEndpointContext, input: PeerEndpoint): void {
  ensurePeerEndpointSchema(db);
  const kind = z.enum(["cluster", "twin"]).parse(context.kind);
  const id = uuid.parse(context.id);
  const endpoint = endpointSchema.parse(input);
  const now=new Date().toISOString();
  db.prepare(`INSERT INTO cluster_v2_peer_activity VALUES(?,?,?,NULL) ON CONFLICT(node_id)
    DO UPDATE SET updated_at=excluded.updated_at`).run(endpoint.nodeId,now,now);
  db.prepare(`INSERT INTO cluster_v2_peer_endpoints(context_kind,context_id,node_id,name,url)
    VALUES(?,?,?,?,?) ON CONFLICT(context_kind,context_id,node_id) DO UPDATE SET
    name=excluded.name,url=excluded.url`).run(kind, id, endpoint.nodeId, endpoint.name, endpoint.url);
}

export function recordSignedPeerSeen(db:DatabaseSync,nodeId:string,now=new Date().toISOString()):void {
  ensurePeerEndpointSchema(db);
  db.prepare(`INSERT INTO cluster_v2_peer_activity VALUES(?,?,?,?) ON CONFLICT(node_id)
    DO UPDATE SET last_seen_at=excluded.last_seen_at`).run(nodeId,now,now,now);
}

export function peerEndpoint(db: DatabaseSync, kind: "cluster" | "twin", id: string, nodeId: string): PeerEndpoint {
  ensurePeerEndpointSchema(db);
  const row = db.prepare(`SELECT node_id nodeId,name,url FROM cluster_v2_peer_endpoints
    WHERE context_kind=? AND context_id=? AND node_id=?`).get(z.enum(["cluster", "twin"]).parse(kind), uuid.parse(id), uuid.parse(nodeId)) as PeerEndpoint | undefined;
  if (!row) throw new Error("Unknown peer endpoint");
  return endpointSchema.parse(row);
}

export function recordMembershipEndpoints(db: DatabaseSync, snapshot: SignedMembershipSnapshot): void {
  for (const member of snapshot.body.members) recordPeerEndpoint(db,
    { kind: "cluster", id: snapshot.body.clusterId },
    { nodeId: member.nodeId, name: member.name, url: member.url });
}
