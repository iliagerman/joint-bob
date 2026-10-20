import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { commandPresetSchema, commandSelectionSchema } from "./saved-commands.js";

export const commandOfferSchema = commandPresetSchema.extend({ id: z.string().min(1).max(600), ownerNodeId: z.string().uuid(), global: z.boolean(), grantClusterIds: z.array(z.string().uuid()).max(100), twinRelationshipId: z.string().uuid().optional(), projectIds: z.array(z.string()).max(500), conversations: commandSelectionSchema.shape.conversations }).strict();
export const commandManifestSchema = z.object({ ownerNodeId: z.string().uuid(), commands: z.array(commandOfferSchema).max(5000) }).strict();
export type CommandOffer = z.infer<typeof commandOfferSchema>;
export interface CommandPeer { nodeId: string; incarnations: string[]; twinRelationshipId?: string }
const snapshotSchema = z.object({ commands: z.array(commandOfferSchema), incarnations: z.array(z.string()), twinRelationshipId: z.string().uuid().optional() });

function ensureSchema(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS received_command_snapshots (owner_node_id TEXT PRIMARY KEY, payload TEXT NOT NULL)");
}

/** Bind stored grants to the relationships that delivered them, never a later rejoin or re-pair. */
export function retainCommandGrants(commands: CommandOffer[], received: Omit<CommandPeer, "nodeId">, current: CommandPeer): CommandOffer[] {
  return commands.flatMap((command) => {
    const grantClusterIds = command.grantClusterIds.filter((id) => current.incarnations.some((incarnation) => incarnation.startsWith(`${id}:`) && received.incarnations.includes(incarnation)));
    // An unpair/re-pair during the request cannot revive the previous grant.
    const twinRelationshipId = command.twinRelationshipId && command.twinRelationshipId === received.twinRelationshipId && command.twinRelationshipId === current.twinRelationshipId ? command.twinRelationshipId : undefined;
    if (!grantClusterIds.length && !twinRelationshipId) return [];
    return [{ ...command, grantClusterIds, twinRelationshipId }];
  });
}

/** A complete owner snapshot replaces edits, deletions and revoked grants in one SQLite write. */
export function replaceReceivedCommands(db: DatabaseSync, peer: CommandPeer, commands: CommandOffer[]): void {
  ensureSchema(db);
  db.prepare("INSERT INTO received_command_snapshots VALUES(?,?) ON CONFLICT(owner_node_id) DO UPDATE SET payload=excluded.payload")
    .run(peer.nodeId, JSON.stringify({ commands, incarnations: peer.incarnations, twinRelationshipId: peer.twinRelationshipId }));
}

export function readReceivedCommands(db: DatabaseSync, peer: CommandPeer): CommandOffer[] {
  ensureSchema(db);
  const row = db.prepare("SELECT payload FROM received_command_snapshots WHERE owner_node_id=?").get(peer.nodeId) as { payload: string } | undefined;
  if (!row) return [];
  const snapshot = snapshotSchema.parse(JSON.parse(row.payload));
  return retainCommandGrants(snapshot.commands, snapshot, peer);
}

export function pruneReceivedCommands(db: DatabaseSync, peers: CommandPeer[]): void {
  ensureSchema(db);
  for (const row of db.prepare("SELECT owner_node_id FROM received_command_snapshots").all() as Array<{ owner_node_id: string }>) {
    if (!peers.some((peer) => peer.nodeId === row.owner_node_id)) db.prepare("DELETE FROM received_command_snapshots WHERE owner_node_id=?").run(row.owner_node_id);
  }
}
