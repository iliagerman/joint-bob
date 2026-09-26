import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { PROJECT_COLORS } from "./types.js";
import {
  hasCurrentResourcePolicyContext, resourcePolicyDeliveryIsCurrent, resourcePolicySchema,
  type SignedResourcePolicy,
} from "./cluster-sharing.js";

export const portableProjectMetadataSchema = z.object({
  name: z.string().trim().min(1).max(1000),
  color: z.enum(PROJECT_COLORS).nullable(),
  workspace: z.object({ id: z.string().min(1).max(300).regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/), label: z.string().min(1).max(40) }).strict().optional(),
  syncFolderId: z.string().min(1).max(300).regex(/^[A-Za-z0-9._-]+$/).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export const projectMetadataEnvelopeSchema = z.object({
  statement: resourcePolicySchema,
  revision: z.number().int().safe().positive(),
  metadata: portableProjectMetadataSchema,
}).strict();
export type ProjectMetadataEnvelope = z.infer<typeof projectMetadataEnvelopeSchema>;
export interface ProjectMetadataDelivery extends ProjectMetadataEnvelope { peerId: string }

export function ensureProjectMetadataSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cluster_v2_project_metadata_versions(
      owner_node_id TEXT NOT NULL,project_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,
      PRIMARY KEY(owner_node_id,project_id));
    CREATE TABLE IF NOT EXISTS cluster_v2_project_metadata_sent(
      operation_id TEXT NOT NULL,peer_id TEXT NOT NULL,revision INTEGER NOT NULL,
      PRIMARY KEY(operation_id,peer_id));
    CREATE TABLE IF NOT EXISTS cluster_v2_project_metadata_receipts(
      owner_node_id TEXT NOT NULL,project_id TEXT NOT NULL,context_kind TEXT NOT NULL,context_id TEXT NOT NULL,
      owner_admission INTEGER NOT NULL,recipient_admission INTEGER NOT NULL,policy_generation INTEGER NOT NULL,
      operation_id TEXT NOT NULL,revision INTEGER NOT NULL,
      PRIMARY KEY(owner_node_id,project_id,context_kind,context_id,owner_admission,recipient_admission));
    CREATE TABLE IF NOT EXISTS cluster_v2_project_workspaces(
      workspace_id TEXT PRIMARY KEY,owner_node_id TEXT UNIQUE NOT NULL);
    CREATE TABLE IF NOT EXISTS cluster_v2_shared_workspaces(
      owner_node_id TEXT NOT NULL,source_workspace_id TEXT NOT NULL,workspace_id TEXT NOT NULL,
      PRIMARY KEY(owner_node_id,source_workspace_id));
  `);
}

function canonicalMetadata(value: unknown): string {
  return JSON.stringify(portableProjectMetadataSchema.parse(value));
}
function metadataForProject(db: DatabaseSync, id: string): ProjectMetadataEnvelope["metadata"] {
  const row = db.prepare("SELECT p.name,p.color,p.sync_folder_id,p.created_at,p.updated_at,p.workspace_id,w.label workspace_label FROM projects p JOIN workspaces w ON w.id=p.workspace_id WHERE p.id=?").get(id) as {
    name: string; color: typeof PROJECT_COLORS[number] | null; sync_folder_id: string | null; workspace_id: string; workspace_label: string; created_at: string; updated_at: string;
  };
  const hasOverrides = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='name_overrides'").get());
  const override = hasOverrides ? db.prepare("SELECT name FROM name_overrides WHERE scope='projects' AND key=?").get(id) as { name: string } | undefined : undefined;
  return portableProjectMetadataSchema.parse({
    name: override?.name ?? row.name, color: row.color,
    ...(row.sync_folder_id ? { syncFolderId: row.sync_folder_id } : {}),
    workspace: { id: row.workspace_id, label: row.workspace_label },
    createdAt: row.created_at, updatedAt: row.updated_at,
  });
}
function captureVersion(db: DatabaseSync, owner: string, id: string, metadata: ProjectMetadataEnvelope["metadata"]): number {
  const payload = canonicalMetadata(metadata);
  const prior = db.prepare("SELECT revision,payload FROM cluster_v2_project_metadata_versions WHERE owner_node_id=? AND project_id=?")
    .get(owner, id) as { revision: number; payload: string } | undefined;
  if (prior?.payload === payload) return prior.revision;
  if (prior?.revision === Number.MAX_SAFE_INTEGER) throw new Error("Project metadata revision exhausted");
  const revision = (prior?.revision ?? 0) + 1;
  db.prepare(`INSERT INTO cluster_v2_project_metadata_versions(owner_node_id,project_id,revision,payload)
    VALUES(?,?,?,?) ON CONFLICT(owner_node_id,project_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload`)
    .run(owner, id, revision, payload);
  return revision;
}

function collectProjectMetadataDeliveries(db: DatabaseSync, local: string): ProjectMetadataDelivery[] {
  db.prepare(`DELETE FROM cluster_v2_project_metadata_sent WHERE operation_id NOT IN
    (SELECT json_extract(statement,'$.body.operationId') FROM cluster_v2_resource_contexts
      WHERE kind='project' AND active=1 AND json_extract(statement,'$.body.ownerNodeId')=?)`).run(local);
  const rows = db.prepare(`SELECT statement FROM cluster_v2_resource_contexts c
    JOIN cluster_v2_resource_policy p ON p.kind=c.kind AND p.resource_id=c.resource_id
    JOIN projects j ON j.id=c.resource_id
    WHERE c.kind='project' AND c.active=1 AND p.deleted=0 AND p.owner_node_id=?
      AND json_extract(c.statement,'$.body.ownerNodeId')=?`).all(local, local) as unknown as Array<{ statement: string }>;
  const deliveries: ProjectMetadataDelivery[] = [];
  for (const row of rows) {
    const statement = resourcePolicySchema.parse(JSON.parse(row.statement));
    if (!resourcePolicyDeliveryIsCurrent(db, local, statement)) continue;
    const metadata = metadataForProject(db, statement.body.resourceId);
    const revision = captureVersion(db, local, statement.body.resourceId, metadata);
    const sent = db.prepare("SELECT revision FROM cluster_v2_project_metadata_sent WHERE operation_id=? AND peer_id=?")
      .get(statement.body.operationId, statement.body.recipientNodeId) as { revision: number } | undefined;
    if (sent?.revision !== revision) deliveries.push({ statement, revision, metadata, peerId: statement.body.recipientNodeId });
  }
  return deliveries;
}

export function listProjectMetadataDeliveries(db: DatabaseSync, local: string): ProjectMetadataDelivery[] {
  ensureProjectMetadataSchema(db);
  db.exec("SAVEPOINT project_metadata_collect");
  try {
    const deliveries = collectProjectMetadataDeliveries(db, local);
    db.exec("RELEASE project_metadata_collect");
    return deliveries;
  } catch (error) {
    db.exec("ROLLBACK TO project_metadata_collect; RELEASE project_metadata_collect");
    throw error;
  }
}

export function acknowledgeProjectMetadataDelivery(db: DatabaseSync, delivery: ProjectMetadataDelivery): void {
  ensureProjectMetadataSchema(db);
  db.prepare(`INSERT INTO cluster_v2_project_metadata_sent(operation_id,peer_id,revision) VALUES(?,?,?)
    ON CONFLICT(operation_id,peer_id) DO UPDATE SET revision=excluded.revision`)
    .run(delivery.statement.body.operationId, delivery.peerId, delivery.revision);
}

export function storedProjectMetadata(
  db: DatabaseSync, ownerNodeId: string, projectId: string,
): ProjectMetadataEnvelope["metadata"] | undefined {
  ensureProjectMetadataSchema(db);
  const row = db.prepare("SELECT payload FROM cluster_v2_project_metadata_versions WHERE owner_node_id=? AND project_id=?")
    .get(ownerNodeId, projectId) as { payload: string } | undefined;
  return row ? portableProjectMetadataSchema.parse(JSON.parse(row.payload)) : undefined;
}

export function validateProjectMetadataVersion(db: DatabaseSync, envelope: ProjectMetadataEnvelope): boolean {
  ensureProjectMetadataSchema(db);
  const body = envelope.statement.body;
  const payload = canonicalMetadata(envelope.metadata);
  const prior = db.prepare("SELECT revision,payload FROM cluster_v2_project_metadata_versions WHERE owner_node_id=? AND project_id=?")
    .get(body.ownerNodeId, body.resourceId) as { revision: number; payload: string } | undefined;
  if (prior?.revision === envelope.revision && prior.payload !== payload) {
    throw new Error("Conflicting project metadata revision");
  }
  return !prior || envelope.revision > prior.revision;
}
export function recordProjectMetadataReceipt(db: DatabaseSync, envelope: ProjectMetadataEnvelope): void {
  ensureProjectMetadataSchema(db);
  const body = envelope.statement.body;
  const ownerAdmission = body.context.kind === "cluster" ? body.context.ownerJoinSequence : 0;
  const recipientAdmission = body.context.kind === "cluster" ? body.context.recipientJoinSequence : 0;
  const prior = db.prepare("SELECT revision FROM cluster_v2_project_metadata_versions WHERE owner_node_id=? AND project_id=?")
    .get(body.ownerNodeId, body.resourceId) as { revision: number } | undefined;
  if (!prior || envelope.revision > prior.revision) db.prepare(`INSERT INTO cluster_v2_project_metadata_versions
    (owner_node_id,project_id,revision,payload) VALUES(?,?,?,?) ON CONFLICT(owner_node_id,project_id)
    DO UPDATE SET revision=excluded.revision,payload=excluded.payload`).run(
      body.ownerNodeId, body.resourceId, envelope.revision, canonicalMetadata(envelope.metadata));
  db.prepare(`INSERT INTO cluster_v2_project_metadata_receipts
    (owner_node_id,project_id,context_kind,context_id,owner_admission,recipient_admission,policy_generation,operation_id,revision)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_node_id,project_id,context_kind,context_id,owner_admission,recipient_admission)
    DO UPDATE SET policy_generation=excluded.policy_generation,operation_id=excluded.operation_id,revision=max(revision,excluded.revision)`)
    .run(body.ownerNodeId, body.resourceId, body.context.kind, body.context.id, ownerAdmission,
      recipientAdmission, body.generation, body.operationId, envelope.revision);
}

export function projectMetadataVisible(db: DatabaseSync, local: string, id: string): boolean {
  ensureProjectMetadataSchema(db);
  const owner = db.prepare("SELECT owner_node_id FROM sharing_resource_owners WHERE kind='project' AND resource_id=?")
    .get(id) as { owner_node_id: string } | undefined;
  if (!owner) return true;
  const policy = db.prepare("SELECT deleted FROM cluster_v2_resource_policy WHERE kind='project' AND resource_id=?")
    .get(id) as { deleted: number } | undefined;
  if (owner.owner_node_id === local) return policy?.deleted === 0;
  const receipts = db.prepare(`SELECT r.*,c.statement FROM cluster_v2_project_metadata_receipts r
    JOIN cluster_v2_resource_contexts c ON c.kind='project' AND c.resource_id=r.project_id
      AND c.context_kind=r.context_kind AND c.context_id=r.context_id AND c.owner_admission=r.owner_admission
      AND c.recipient_admission=r.recipient_admission AND c.recipient_id=? AND c.generation=r.policy_generation
    WHERE r.owner_node_id=? AND r.project_id=? AND r.operation_id=json_extract(c.statement,'$.body.operationId')`)
    .all(local, owner.owner_node_id, id) as unknown as Array<{ statement: string }>;
  return receipts.some((row) => hasCurrentResourcePolicyContext(db, local,
    resourcePolicySchema.parse(JSON.parse(row.statement)) as SignedResourcePolicy));
}
