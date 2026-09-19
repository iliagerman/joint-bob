import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  ensureClusterIdentitySchema,
  pinnedClusterPublicKey,
  signClusterMessage,
  verifyClusterMessage,
} from "./cluster-identity.js";
import {
  ensureClusterSharingPolicySchema,
  getSharingCluster,
  listResourceShares,
  listSharingClusterMembers,
  registerOwnedResource,
  resourceClusterIds,
  resourceOwner,
  setResourceShares,
  type ResourceShare,
  type SharedResourceKind,
} from "./cluster-sharing-policy.js";
import { ensureTwinSchema } from "./cluster-twins.js";

export type PolicyKind = "project" | "secret";
export type SharingContext =
  | { kind: "cluster"; id: string; ownerJoinSequence: number; recipientJoinSequence: number }
  | { kind: "twin"; id: string };
export interface PolicyBody {
  kind: PolicyKind;
  resourceId: string;
  ownerNodeId: string;
  writerNodeId: string;
  generation: number;
  operationId: string;
  operation: "upsert" | "unshare" | "delete";
  recipientNodeId: string;
  context: SharingContext;
  shares: ResourceShare[];
}
export interface SignedResourcePolicy { body: PolicyBody; signature: string }
export interface ResourcePolicyState {
  kind: PolicyKind;
  resourceId: string;
  ownerNodeId: string;
  generation: number;
  deleted: boolean;
}
export class ResourceSharingError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}

const uuid = z.string().uuid().regex(/^[0-9a-f-]+$/);
const resourceId = z.string().min(1).max(300)
  .refine((value) => value === value.trim() && !/[\x00-\x1f\x7f]/.test(value));
const policyKind = z.enum(["project", "secret"]);
const sharedKind = z.enum(["project", "secret", "ticket"]);
const resourceShare = z.object({ clusterId: uuid, projectId: resourceId.nullable() }).strict();
const contextSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cluster"), id: uuid,
    ownerJoinSequence: z.number().int().safe().positive(),
    recipientJoinSequence: z.number().int().safe().positive(),
  }).strict(),
  z.object({ kind: z.literal("twin"), id: uuid }).strict(),
]);
const bodySchema = z.object({
  kind: policyKind, resourceId, ownerNodeId: uuid, writerNodeId: uuid,
  generation: z.number().int().safe().positive(), operationId: uuid,
  operation: z.enum(["upsert", "unshare", "delete"]), recipientNodeId: uuid,
  context: contextSchema, shares: z.array(resourceShare),
}).strict();
const signedSchema = z.object({
  body: bodySchema,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
}).strict();
export const resourcePolicySchema = signedSchema;

interface StateRow {
  kind: PolicyKind;
  resource_id: string;
  owner_node_id: string;
  generation: number;
  deleted: number;
}
interface ContextRow {
  context_kind: "cluster" | "twin";
  context_id: string;
  owner_admission: number;
  recipient_admission: number;
  recipient_id: string;
  generation: number;
  statement: string;
  effective_shares: string;
  active: number;
}
interface EmissionTarget { peer: string; context: SharingContext; shares: ResourceShare[] }

function ensureResourceDeletionSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cluster_v2_resource_deletions (
      owner_node_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('project','secret')),
      resource_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation > 0),
      PRIMARY KEY(owner_node_id,kind,resource_id)
    );
  `);
}

export function ensureResourceSharingSchema(db: DatabaseSync): void {
  ensureClusterSharingPolicySchema(db);
  ensureClusterIdentitySchema(db);
  ensureTwinSchema(db);
  ensureResourceDeletionSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS cluster_v2_resource_policy (
      kind TEXT NOT NULL CHECK(kind IN ('project','secret')),
      resource_id TEXT NOT NULL,
      owner_node_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation > 0),
      deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),
      PRIMARY KEY(kind, resource_id)
    );
    CREATE TABLE IF NOT EXISTS cluster_v2_resource_contexts (
      kind TEXT NOT NULL CHECK(kind IN ('project','secret')),
      resource_id TEXT NOT NULL,
      context_kind TEXT NOT NULL CHECK(context_kind IN ('cluster','twin')),
      context_id TEXT NOT NULL,
      owner_admission INTEGER NOT NULL CHECK(owner_admission >= 0),
      recipient_admission INTEGER NOT NULL CHECK(recipient_admission >= 0),
      recipient_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation > 0),
      statement TEXT NOT NULL,
      effective_shares TEXT NOT NULL,
      active INTEGER NOT NULL CHECK(active IN (0,1)),
      PRIMARY KEY(kind, resource_id, context_kind, context_id,
        owner_admission, recipient_admission, recipient_id)
    );
    CREATE TABLE IF NOT EXISTS cluster_v2_resource_deliveries (
      operation_id TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('project','secret')),
      resource_id TEXT NOT NULL,
      context_kind TEXT NOT NULL CHECK(context_kind IN ('cluster','twin')),
      context_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation > 0),
      statement TEXT NOT NULL,
      PRIMARY KEY(operation_id, peer_id)
    );
    CREATE INDEX IF NOT EXISTS cluster_v2_resource_context_resource
      ON cluster_v2_resource_contexts(kind, resource_id);
    CREATE INDEX IF NOT EXISTS cluster_v2_resource_delivery_resource
      ON cluster_v2_resource_deliveries(kind, resource_id);
  `);
}

function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec("SAVEPOINT resource_policy_write");
  try {
    const result = action();
    db.exec("RELEASE resource_policy_write");
    return result;
  } catch (error) {
    db.exec("ROLLBACK TO resource_policy_write; RELEASE resource_policy_write");
    throw error;
  }
}

function policyRow(db: DatabaseSync, kind: PolicyKind, id: string): StateRow | undefined {
  return db.prepare(
    "SELECT kind,resource_id,owner_node_id,generation,deleted FROM cluster_v2_resource_policy WHERE kind=? AND resource_id=?",
  ).get(kind, id) as unknown as StateRow | undefined;
}
function deletionGeneration(
  db: DatabaseSync, owner: string, kind: PolicyKind, id: string,
): number | undefined {
  const row = db.prepare(`
    SELECT generation FROM cluster_v2_resource_deletions
    WHERE owner_node_id=? AND kind=? AND resource_id=?
  `).get(owner, kind, id) as { generation: number } | undefined;
  return row?.generation;
}
function recordDeletion(
  db: DatabaseSync, owner: string, kind: PolicyKind, id: string, generation: number,
): void {
  db.prepare(`
    INSERT INTO cluster_v2_resource_deletions
      (owner_node_id,kind,resource_id,generation) VALUES (?,?,?,?)
    ON CONFLICT(owner_node_id,kind,resource_id) DO UPDATE SET
      generation=max(generation,excluded.generation)
  `).run(owner, kind, id, generation);
}
function installedResourceOwner(
  db: DatabaseSync, kind: PolicyKind, id: string,
): string | undefined {
  const row = db.prepare(`
    SELECT owner_node_id FROM sharing_resource_owners WHERE kind=? AND resource_id=?
  `).get(kind, id) as { owner_node_id: string } | undefined;
  return row?.owner_node_id;
}
function publicState(row: StateRow): ResourcePolicyState {
  return {
    kind: row.kind, resourceId: row.resource_id, ownerNodeId: row.owner_node_id,
    generation: row.generation, deleted: row.deleted === 1,
  };
}
function resolveTarget(db: DatabaseSync, kind: SharedResourceKind, id: string): { kind: PolicyKind; id: string } | undefined {
  if (kind !== "ticket") return { kind, id };
  const row = db.prepare(
    "SELECT project_id FROM sharing_resource_owners WHERE kind='ticket' AND resource_id=?",
  ).get(id) as { project_id: string } | undefined;
  return row ? { kind: "project", id: row.project_id } : undefined;
}

export function getResourcePolicyState(
  db: DatabaseSync, kind: SharedResourceKind, id: string,
): ResourcePolicyState {
  ensureResourceSharingSchema(db);
  const parsedKind = sharedKind.parse(kind);
  const parsedId = resourceId.parse(id);
  const target = resolveTarget(db, parsedKind, parsedId);
  if (!target) throw new Error("Unknown ticket resource");
  const row = policyRow(db, target.kind, target.id);
  if (!row) throw new Error("Unknown resource policy");
  return publicState(row);
}

function sorted(shares: ResourceShare[]): ResourceShare[] {
  return [...shares].sort((left, right) =>
    left.clusterId.localeCompare(right.clusterId)
    || (left.projectId ?? "").localeCompare(right.projectId ?? ""));
}
function admissions(context: SharingContext): [number, number] {
  return context.kind === "cluster"
    ? [context.ownerJoinSequence, context.recipientJoinSequence]
    : [0, 0];
}
function contextKey(peer: string, context: SharingContext): string {
  const [ownerAdmission, recipientAdmission] = admissions(context);
  return [peer, context.kind, context.id, ownerAdmission, recipientAdmission].join("\0");
}

function currentContexts(
  db: DatabaseSync, owner: string, kind: PolicyKind, id: string,
): EmissionTarget[] {
  const result: EmissionTarget[] = [];
  const shares = listResourceShares(db, kind, id);
  for (const clusterId of new Set(shares.map((item) => item.clusterId))) {
    const cluster = getSharingCluster(db, clusterId);
    if (cluster.closed) continue;
    const members = listSharingClusterMembers(db, clusterId);
    const ownerMember = members.find((member) => member.nodeId === owner);
    if (!ownerMember) continue;
    for (const member of members) {
      if (member.nodeId === owner) continue;
      result.push({
        peer: member.nodeId,
        context: {
          kind: "cluster", id: clusterId,
          ownerJoinSequence: ownerMember.joinSequence,
          recipientJoinSequence: member.joinSequence,
        },
        shares: shares.filter((share) => share.clusterId === clusterId),
      });
    }
  }
  const twins = db.prepare(`
    SELECT relationship_id,peer_node_id FROM cluster_v2_twin_relationships
    WHERE local_node_id=? AND status='active'
  `).all(owner) as unknown as Array<{ relationship_id: string; peer_node_id: string }>;
  for (const twin of twins) {
    result.push({ peer: twin.peer_node_id, context: { kind: "twin", id: twin.relationship_id }, shares: [] });
  }
  return result;
}

function signBody(db: DatabaseSync, body: PolicyBody): SignedResourcePolicy {
  return { body, signature: signClusterMessage(db, body.ownerNodeId, "resource-policy", JSON.stringify(body)) };
}
function storeEmission(db: DatabaseSync, bodyInput: PolicyBody, active: boolean): void {
  const body = bodySchema.parse({ ...bodyInput, shares: sorted(bodyInput.shares) });
  const statement = signBody(db, body);
  const text = JSON.stringify(statement);
  const [ownerAdmission, recipientAdmission] = admissions(body.context);
  db.prepare(`
    INSERT INTO cluster_v2_resource_contexts
      (kind,resource_id,context_kind,context_id,owner_admission,recipient_admission,
       recipient_id,generation,statement,effective_shares,active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(kind,resource_id,context_kind,context_id,owner_admission,
      recipient_admission,recipient_id) DO UPDATE SET
      generation=excluded.generation,statement=excluded.statement,
      effective_shares=excluded.effective_shares,active=excluded.active
  `).run(
    body.kind, body.resourceId, body.context.kind, body.context.id,
    ownerAdmission, recipientAdmission, body.recipientNodeId, body.generation,
    text, JSON.stringify(active ? body.shares : []), active ? 1 : 0,
  );
  if (body.operation !== "upsert") cancelSupersededUpserts(db, body, ownerAdmission, recipientAdmission);
  db.prepare(`
    INSERT OR IGNORE INTO cluster_v2_resource_deliveries
      (operation_id,peer_id,kind,resource_id,context_kind,context_id,generation,statement)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(
    body.operationId, body.recipientNodeId, body.kind, body.resourceId,
    body.context.kind, body.context.id, body.generation, text,
  );
}
function cancelSupersededUpserts(
  db: DatabaseSync, body: PolicyBody, ownerAdmission: number, recipientAdmission: number,
): void {
  db.prepare(`
    DELETE FROM cluster_v2_resource_deliveries
    WHERE kind=? AND resource_id=? AND peer_id=? AND context_kind=? AND context_id=?
      AND generation<=? AND json_extract(statement,'$.body.operation')='upsert'
      AND CASE WHEN context_kind='cluster' THEN
        json_extract(statement,'$.body.context.ownerJoinSequence')=? AND
        json_extract(statement,'$.body.context.recipientJoinSequence')=?
      ELSE json_extract(statement,'$.body.context.id')=? END
  `).run(
    body.kind, body.resourceId, body.recipientNodeId, body.context.kind,
    body.context.id, body.generation, ownerAdmission, recipientAdmission, body.context.id,
  );
}

function historicalContexts(
  db: DatabaseSync, owner: string, kind: PolicyKind, id: string,
): EmissionTarget[] {
  const rows = db.prepare(`
    SELECT context_kind,context_id,owner_admission,recipient_admission,recipient_id,
      generation,statement,effective_shares,active
    FROM cluster_v2_resource_contexts WHERE kind=? AND resource_id=?
      AND json_extract(statement,'$.body.ownerNodeId')=?
  `).all(kind, id, owner) as unknown as ContextRow[];
  return rows.map((row) => ({
    peer: row.recipient_id,
    context: row.context_kind === "cluster"
      ? {
          kind: "cluster", id: row.context_id,
          ownerJoinSequence: row.owner_admission,
          recipientJoinSequence: row.recipient_admission,
        }
      : { kind: "twin", id: row.context_id },
    shares: [],
  }));
}
function emit(
  db: DatabaseSync, owner: string, kind: PolicyKind, id: string,
  generation: number, operation: "upsert" | "delete",
): void {
  const current = new Map(currentContexts(db, owner, kind, id)
    .map((target) => [contextKey(target.peer, target.context), target]));
  const emissions = new Map<string, EmissionTarget & { operation: PolicyBody["operation"] }>();
  if (operation === "upsert") {
    for (const [key, target] of current) emissions.set(key, { ...target, operation: "upsert" });
    for (const target of historicalContexts(db, owner, kind, id)) {
      const key = contextKey(target.peer, target.context);
      if (!current.has(key)) emissions.set(key, { ...target, operation: "unshare" });
    }
  } else {
    for (const target of [...current.values(), ...historicalContexts(db, owner, kind, id)]) {
      emissions.set(contextKey(target.peer, target.context), { ...target, operation: "delete" });
    }
  }
  for (const target of emissions.values()) {
    storeEmission(db, {
      kind, resourceId: id, ownerNodeId: owner, writerNodeId: owner, generation,
      operationId: randomUUID(), operation: target.operation, recipientNodeId: target.peer,
      context: target.context, shares: target.operation === "upsert" ? target.shares : [],
    }, target.operation === "upsert");
  }
}

export function registerLocalSharingResource(
  db: DatabaseSync, local: string, resource: { kind: PolicyKind; id: string },
): ResourcePolicyState {
  ensureResourceSharingSchema(db);
  const nodeId = uuid.parse(local);
  const kind = policyKind.parse(resource.kind);
  const id = resourceId.parse(resource.id);
  return transaction(db, () => {
    const terminal = deletionGeneration(db, nodeId, kind, id);
    if (terminal !== undefined) throw new Error("Deleted resource cannot be restored");
    const existing = policyRow(db, kind, id);
    if (existing) {
      if (existing.owner_node_id !== nodeId) throw new Error("Resource original owner cannot be changed");
      if (existing.deleted) throw new Error("Deleted resource cannot be restored");
      return publicState(existing);
    }
    registerOwnedResource(db, { kind, id, ownerNodeId: nodeId }, nodeId);
    db.prepare(`
      INSERT INTO cluster_v2_resource_policy
        (kind,resource_id,owner_node_id,generation,deleted) VALUES (?,?,?,1,0)
    `).run(kind, id, nodeId);
    emit(db, nodeId, kind, id, 1, "upsert");
    return publicState(policyRow(db, kind, id)!);
  });
}

function mutablePolicy(
  db: DatabaseSync, local: string, kind: PolicyKind, id: string, expected: number,
): StateRow {
  const row = policyRow(db, kind, id);
  if (!row) throw new Error("Unknown resource policy");
  if (row.owner_node_id !== local || resourceOwner(db, kind, id) !== local) {
    throw new Error("Only the original owner may change sharing");
  }
  if (row.deleted) throw new Error("Resource is deleted");
  if (row.generation !== expected) throw new ResourceSharingError("Resource policy generation conflict", 409);
  if (expected === Number.MAX_SAFE_INTEGER) throw new Error("Resource policy generation exhausted");
  return row;
}
function validateMutation(local: string, kind: SharedResourceKind, id: string, expected: number): void {
  uuid.parse(local);
  sharedKind.parse(kind);
  resourceId.parse(id);
  if (!Number.isSafeInteger(expected) || expected < 0) throw new Error("Invalid expected generation");
}

export function updateResourceSharing(
  db: DatabaseSync, local: string, kind: SharedResourceKind, id: string,
  expected: number, shares: ResourceShare[],
): ResourcePolicyState {
  ensureResourceSharingSchema(db);
  validateMutation(local, kind, id, expected);
  if (kind === "ticket") throw new Error("Ticket sharing is inherited from its project");
  const parsedShares = z.array(resourceShare).parse(shares);
  return transaction(db, () => {
    const prior = mutablePolicy(db, local, kind, id, expected);
    const generation = prior.generation + 1;
    setResourceShares(db, local, kind, id, sorted(parsedShares));
    if (kind === "project") pruneSecretScopes(db, id);
    db.prepare("UPDATE cluster_v2_resource_policy SET generation=? WHERE kind=? AND resource_id=?")
      .run(generation, kind, id);
    emit(db, local, kind, id, generation, "upsert");
    return publicState(policyRow(db, kind, id)!);
  });
}

export function deleteSharedResource(
  db: DatabaseSync, local: string, kind: PolicyKind, id: string, expected: number,
): ResourcePolicyState {
  ensureResourceSharingSchema(db);
  validateMutation(local, kind, id, expected);
  const parsedKind = policyKind.parse(kind);
  return transaction(db, () => {
    const prior = mutablePolicy(db, local, parsedKind, id, expected);
    const generation = prior.generation + 1;
    setResourceShares(db, local, parsedKind, id, []);
    if (parsedKind === "project") pruneSecretScopes(db, id);
    db.prepare(`
      UPDATE cluster_v2_resource_policy SET generation=?,deleted=1
      WHERE kind=? AND resource_id=?
    `).run(generation, parsedKind, id);
    recordDeletion(db, local, parsedKind, id, generation);
    emit(db, local, parsedKind, id, generation, "delete");
    return publicState(policyRow(db, parsedKind, id)!);
  });
}

function activeContextRows(
  db: DatabaseSync, owner: string, kind: PolicyKind, id: string,
): Map<string, { generation: number; shares: ResourceShare[] }> {
  const rows = db.prepare(`
    SELECT context_kind,context_id,owner_admission,recipient_admission,recipient_id,
      generation,effective_shares FROM cluster_v2_resource_contexts
    WHERE kind=? AND resource_id=? AND active=1
      AND json_extract(statement,'$.body.ownerNodeId')=?
  `).all(kind, id, owner) as unknown as Array<ContextRow>;
  return new Map(rows.map((row) => {
    const context: SharingContext = row.context_kind === "cluster"
      ? { kind: "cluster", id: row.context_id, ownerJoinSequence: row.owner_admission,
          recipientJoinSequence: row.recipient_admission }
      : { kind: "twin", id: row.context_id };
    return [contextKey(row.recipient_id, context), {
      generation: row.generation,
      shares: sorted(z.array(resourceShare).parse(JSON.parse(row.effective_shares))),
    }];
  }));
}

function reconcileOwnedResource(
  db: DatabaseSync, local: string, row: StateRow,
): void {
  const current = new Map(currentContexts(db, local, row.kind, row.resource_id)
    .map((target) => [contextKey(target.peer, target.context), target]));
  const active = activeContextRows(db, local, row.kind, row.resource_id);
  const changed = [...active].some(([key, prior]) => {
    const target = current.get(key);
    return !target || JSON.stringify(prior.shares) !== JSON.stringify(sorted(target.shares));
  });
  if (changed) {
    if (row.generation === Number.MAX_SAFE_INTEGER) throw new Error("Resource policy generation exhausted");
    const generation = row.generation + 1;
    db.prepare("UPDATE cluster_v2_resource_policy SET generation=? WHERE kind=? AND resource_id=?")
      .run(generation, row.kind, row.resource_id);
    emit(db, local, row.kind, row.resource_id, generation, "upsert");
    return;
  }
  const missing = [...current].some(([key, target]) => {
    const prior = active.get(key);
    return !prior || prior.generation !== row.generation
      || JSON.stringify(prior.shares) !== JSON.stringify(sorted(target.shares));
  });
  if (missing) queueResourcePolicyBootstrap(db, local, row.kind, row.resource_id);
}

export function reconcileOwnedResourceTopology(
  db: DatabaseSync, localInput: string, clusterInput: string,
): void {
  ensureResourceSharingSchema(db);
  const local = uuid.parse(localInput);
  const cluster = uuid.parse(clusterInput);
  transaction(db, () => {
    const rows = db.prepare(`
      SELECT DISTINCT p.kind,p.resource_id,p.owner_node_id,p.generation,p.deleted
      FROM cluster_v2_resource_policy p
      WHERE p.owner_node_id=? AND p.deleted=0 AND (
        EXISTS (SELECT 1 FROM sharing_resource_shares s WHERE s.kind=p.kind
          AND s.resource_id=p.resource_id AND s.cluster_id=?) OR
        EXISTS (SELECT 1 FROM cluster_v2_resource_contexts c
          WHERE c.kind=p.kind AND c.resource_id=p.resource_id AND c.context_kind='cluster'
            AND c.context_id=? AND json_extract(c.statement,'$.body.ownerNodeId')=?))
      ORDER BY CASE p.kind WHEN 'project' THEN 0 ELSE 1 END,p.resource_id
    `).all(local, cluster, cluster, local) as unknown as StateRow[];
    for (const row of rows) reconcileOwnedResource(db, local, row);
  });
}

export function queueResourcePolicyBootstrap(
  db: DatabaseSync, local: string, kind: PolicyKind, id: string,
): void {
  ensureResourceSharingSchema(db);
  uuid.parse(local); policyKind.parse(kind); resourceId.parse(id);
  transaction(db, () => {
    const state = policyRow(db, kind, id);
    if (!state || state.owner_node_id !== local || state.deleted) {
      throw new Error("Only the current owner may bootstrap sharing");
    }
    for (const target of currentContexts(db, local, kind, id)) {
      const [ownerAdmission, recipientAdmission] = admissions(target.context);
      const saved = db.prepare(`
        SELECT statement FROM cluster_v2_resource_contexts
        WHERE kind=? AND resource_id=? AND context_kind=? AND context_id=?
          AND owner_admission=? AND recipient_admission=? AND recipient_id=?
          AND generation=? AND active=1
      `).get(
        kind, id, target.context.kind, target.context.id, ownerAdmission,
        recipientAdmission, target.peer, state.generation,
      ) as { statement: string } | undefined;
      if (!saved) {
        storeEmission(db, {
          kind, resourceId: id, ownerNodeId: local, writerNodeId: local,
          generation: state.generation, operationId: randomUUID(), operation: "upsert",
          recipientNodeId: target.peer, context: target.context, shares: target.shares,
        }, true);
        continue;
      }
      const statement = signedSchema.parse(JSON.parse(saved.statement));
      db.prepare(`
        INSERT OR IGNORE INTO cluster_v2_resource_deliveries
          (operation_id,peer_id,kind,resource_id,context_kind,context_id,generation,statement)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(
        statement.body.operationId, target.peer, kind, id, target.context.kind,
        target.context.id, state.generation, saved.statement,
      );
    }
  });
}

function twinActive(db: DatabaseSync, id: string, local: string, owner: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM cluster_v2_twin_relationships
    WHERE relationship_id=? AND local_node_id=? AND peer_node_id=? AND status='active'
  `).get(id, local, owner));
}
function clusterContextValid(db: DatabaseSync, body: PolicyBody): boolean {
  if (body.context.kind !== "cluster") return false;
  const cluster = getSharingCluster(db, body.context.id);
  if (cluster.closed) return false;
  const members = listSharingClusterMembers(db, body.context.id);
  const owner = members.find((member) => member.nodeId === body.ownerNodeId);
  const recipient = members.find((member) => member.nodeId === body.recipientNodeId);
  return owner?.joinSequence === body.context.ownerJoinSequence
    && recipient?.joinSequence === body.context.recipientJoinSequence;
}
function effectiveShares(
  db: DatabaseSync, owner: string, kind: PolicyKind, id: string,
): ResourceShare[] {
  const rows = db.prepare(`
    SELECT rowid,statement,effective_shares FROM cluster_v2_resource_contexts
    WHERE kind=? AND resource_id=? AND active=1 AND context_kind='cluster'
      AND json_extract(statement,'$.body.ownerNodeId')=?
  `).all(kind, id, owner) as unknown as Array<{
    rowid: number; statement: string; effective_shares: string;
  }>;
  const shares: ResourceShare[] = [];
  for (const row of rows) {
    const statement = signedSchema.parse(JSON.parse(row.statement));
    if (!clusterContextValid(db, statement.body)) {
      db.prepare(`
        UPDATE cluster_v2_resource_contexts SET active=0,effective_shares='[]' WHERE rowid=?
      `).run(row.rowid);
      continue;
    }
    shares.push(...z.array(resourceShare).parse(JSON.parse(row.effective_shares)));
  }
  return sorted([...new Map(shares.map((share) =>
    [`${share.clusterId}\0${share.projectId ?? ""}`, share])).values()]);
}
function pruneSecretScopes(db: DatabaseSync, projectId: string): void {
  const activeClusters = new Set(listResourceShares(db, "project", projectId)
    .map((share) => share.clusterId));
  const rows = db.prepare(`
    SELECT DISTINCT contexts.rowid,contexts.effective_shares
    FROM cluster_v2_resource_contexts AS contexts,
      json_each(contexts.effective_shares) AS share
    WHERE contexts.kind='secret' AND contexts.active=1
      AND json_extract(share.value,'$.projectId')=?
  `).all(projectId) as unknown as Array<{ rowid: number; effective_shares: string }>;
  for (const row of rows) {
    const shares = z.array(resourceShare).parse(JSON.parse(row.effective_shares));
    const kept = shares.filter((share) =>
      share.projectId !== projectId || activeClusters.has(share.clusterId));
    if (kept.length === shares.length) continue;
    db.prepare(`
      UPDATE cluster_v2_resource_contexts SET effective_shares=?,active=? WHERE rowid=?
    `).run(JSON.stringify(kept), kept.length ? 1 : 0, row.rowid);
  }
}

function validateFragment(body: PolicyBody): void {
  if (body.operation !== "upsert") {
    if (body.shares.length) throw new Error("Resource revocation shares must be empty");
    return;
  }
  if (body.context.kind === "twin") {
    if (body.shares.length) throw new Error("Twin resource fragment shares must be empty");
    return;
  }
  if (body.shares.some((share) => share.clusterId !== body.context.id)) {
    throw new Error("Invalid context fragment");
  }
  if (body.kind === "project") {
    if (body.shares.length !== 1 || body.shares[0].projectId !== null) {
      throw new Error("Invalid project context fragment");
    }
  } else if (!body.shares.length) {
    throw new Error("Secret context fragment must not be empty");
  }
}
function authorizeStatement(
  db: DatabaseSync, local: string, sender: string, body: PolicyBody,
  existing: StateRow | undefined, prior: { generation: number; statement: string } | undefined,
): void {
  if (body.operation === "upsert") {
    if (body.context.kind === "cluster") {
      const senderIsMember = listSharingClusterMembers(db, body.context.id)
        .some((member) => member.nodeId === sender);
      if (!clusterContextValid(db, body) || (sender !== body.ownerNodeId && !senderIsMember)) {
        throw new Error("Unauthorized cluster policy context");
      }
    } else if (sender !== body.ownerNodeId
      || !twinActive(db, body.context.id, local, body.ownerNodeId)) {
      throw new Error("Unauthorized twin policy context");
    }
    return;
  }
  if (sender !== body.ownerNodeId) throw new Error("Only owner may revoke policy");
  const currentlyValid = body.context.kind === "cluster"
    ? clusterContextValid(db, body)
    : twinActive(db, body.context.id, local, body.ownerNodeId);
  if (!prior && !currentlyValid) throw new Error("Unknown resource revocation context");
}

export function applyResourcePolicy(
  db: DatabaseSync, localInput: string, senderInput: string, input: SignedResourcePolicy,
): void {
  ensureResourceSharingSchema(db);
  const local = uuid.parse(localInput);
  const sender = uuid.parse(senderInput);
  const statement = signedSchema.parse(input);
  const body = statement.body;
  validateFragment(body);
  if (body.writerNodeId !== body.ownerNodeId || body.recipientNodeId !== local) {
    throw new Error("Invalid resource policy authority");
  }
  const pin = pinnedClusterPublicKey(db, body.ownerNodeId);
  if (!pin) throw new Error("Resource owner public key is not pinned");
  if (!verifyClusterMessage(pin, "resource-policy", JSON.stringify(body), statement.signature)) {
    throw new Error("Invalid resource policy signature");
  }
  if (JSON.stringify(body.shares) !== JSON.stringify(sorted(body.shares))
    || new Set(body.shares.map((share) => `${share.clusterId}\0${share.projectId ?? ""}`)).size !== body.shares.length) {
    throw new Error("Resource shares are not canonical");
  }
  transaction(db, () => applyVerifiedPolicy(db, local, sender, statement));
}

function applyVerifiedPolicy(
  db: DatabaseSync, local: string, sender: string, statement: SignedResourcePolicy,
): void {
  const body = statement.body;
  const existing = policyRow(db, body.kind, body.resourceId);
  const installedOwner = installedResourceOwner(db, body.kind, body.resourceId);
  if ((existing && existing.owner_node_id !== body.ownerNodeId)
    || (installedOwner && installedOwner !== body.ownerNodeId)) {
    throw new Error("Resource original owner cannot be changed");
  }
  if (existing?.deleted && body.operation !== "delete") throw new Error("Deleted resource cannot be restored");
  const [ownerAdmission, recipientAdmission] = admissions(body.context);
  const prior = db.prepare(`
    SELECT generation,statement FROM cluster_v2_resource_contexts
    WHERE kind=? AND resource_id=? AND context_kind=? AND context_id=?
      AND owner_admission=? AND recipient_admission=? AND recipient_id=?
      AND json_extract(statement,'$.body.ownerNodeId')=?
  `).get(
    body.kind, body.resourceId, body.context.kind, body.context.id,
    ownerAdmission, recipientAdmission, local, body.ownerNodeId,
  ) as { generation: number; statement: string } | undefined;
  if (prior && body.generation < prior.generation) throw new Error("Stale resource policy");
  authorizeStatement(db, local, sender, body, existing, prior);
  const terminal = deletionGeneration(db, body.ownerNodeId, body.kind, body.resourceId);
  if (terminal !== undefined && body.operation !== "delete") {
    throw new Error("Resource deletion is terminal");
  }
  if (prior && body.generation === prior.generation) {
    if (prior.statement === JSON.stringify(statement)) return;
    throw new Error("Conflicting resource policy generation");
  }
  persistIncomingPolicy(db, local, statement, existing, ownerAdmission, recipientAdmission);
}

function persistIncomingPolicy(
  db: DatabaseSync, local: string, statement: SignedResourcePolicy,
  existing: StateRow | undefined, ownerAdmission: number, recipientAdmission: number,
): void {
  const body = statement.body;
  if (body.operation === "delete" && existing && body.generation < existing.generation) {
    throw new Error("Stale resource deletion");
  }
  if (!existing && body.operation === "upsert") {
    registerOwnedResource(db, {
      kind: body.kind, id: body.resourceId, ownerNodeId: body.ownerNodeId,
    }, local);
    db.prepare(`
      INSERT INTO cluster_v2_resource_policy
        (kind,resource_id,owner_node_id,generation,deleted) VALUES (?,?,?,?,0)
    `).run(body.kind, body.resourceId, body.ownerNodeId, body.generation);
  }
  persistContextRow(db, local, statement, ownerAdmission, recipientAdmission);
  if (!existing && body.operation !== "upsert") {
    if (body.operation === "delete") {
      recordDeletion(db, body.ownerNodeId, body.kind, body.resourceId, body.generation);
    }
    return;
  }
  if (body.operation === "delete") recordDeletion(
    db, body.ownerNodeId, body.kind, body.resourceId, body.generation,
  );
  if (body.operation === "delete") {
    db.prepare(`
      UPDATE cluster_v2_resource_contexts SET active=0,effective_shares='[]'
      WHERE kind=? AND resource_id=?
        AND json_extract(statement,'$.body.ownerNodeId')=?
    `).run(body.kind, body.resourceId, body.ownerNodeId);
  }
  const generation = Math.max(existing?.generation ?? 0, body.generation);
  db.prepare(`
    UPDATE cluster_v2_resource_policy SET generation=?,deleted=?
    WHERE kind=? AND resource_id=?
  `).run(generation, body.operation === "delete" ? 1 : 0, body.kind, body.resourceId);
  const projected = body.operation === "delete" ? []
    : effectiveShares(db, body.ownerNodeId, body.kind, body.resourceId);
  setResourceShares(db, body.ownerNodeId, body.kind, body.resourceId, projected);
  if (body.kind === "project") pruneSecretScopes(db, body.resourceId);
}

function persistContextRow(
  db: DatabaseSync, local: string, statement: SignedResourcePolicy,
  ownerAdmission: number, recipientAdmission: number,
): void {
  const body = statement.body;
  db.prepare(`
    INSERT INTO cluster_v2_resource_contexts
      (kind,resource_id,context_kind,context_id,owner_admission,recipient_admission,
       recipient_id,generation,statement,effective_shares,active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(kind,resource_id,context_kind,context_id,owner_admission,
      recipient_admission,recipient_id) DO UPDATE SET
      generation=excluded.generation,statement=excluded.statement,
      effective_shares=excluded.effective_shares,active=excluded.active
  `).run(
    body.kind, body.resourceId, body.context.kind, body.context.id,
    ownerAdmission, recipientAdmission, local, body.generation, JSON.stringify(statement),
    JSON.stringify(body.operation === "upsert" ? body.shares : []),
    body.operation === "upsert" ? 1 : 0,
  );
}

export function mayForwardResourceContext(
  db: DatabaseSync, localInput: string, recipientInput: string,
  kindInput: SharedResourceKind, idInput: string,
  sourceInput: SharingContext, destinationInput: SharingContext,
): boolean {
  ensureResourceSharingSchema(db);
  const local = uuid.parse(localInput);
  const recipient = uuid.parse(recipientInput);
  const kind = sharedKind.parse(kindInput);
  const id = resourceId.parse(idInput);
  const source = contextSchema.parse(sourceInput);
  const destination = contextSchema.parse(destinationInput);
  const target = resolveTarget(db, kind, id);
  if (!target) return false;
  const state = policyRow(db, target.kind, target.id);
  if (!state || state.deleted || state.owner_node_id === local) return false;
  if (source.kind !== "cluster" || destination.kind !== "cluster") return false;
  if (source.id !== destination.id) return false;
  const cluster = getSharingCluster(db, source.id);
  if (cluster.closed) return false;
  const members = listSharingClusterMembers(db, source.id);
  const owner = members.find((member) => member.nodeId === state.owner_node_id);
  const localMember = members.find((member) => member.nodeId === local);
  const recipientMember = members.find((member) => member.nodeId === recipient);
  if (owner?.joinSequence !== source.ownerJoinSequence
    || owner.joinSequence !== destination.ownerJoinSequence
    || localMember?.joinSequence !== source.recipientJoinSequence
    || recipientMember?.joinSequence !== destination.recipientJoinSequence) return false;
  const active = db.prepare(`
    SELECT 1 FROM cluster_v2_resource_contexts
    WHERE kind=? AND resource_id=? AND context_kind='cluster' AND context_id=?
      AND owner_admission=? AND recipient_admission=? AND recipient_id=? AND active=1
  `).get(
    target.kind, target.id, source.id, source.ownerJoinSequence,
    source.recipientJoinSequence, local,
  );
  if (!active) return false;
  const localClusters = resourceClusterIds(db, local, target.kind, target.id);
  const recipientClusters = resourceClusterIds(db, recipient, target.kind, target.id);
  return localClusters.includes(source.id) && recipientClusters.includes(source.id);
}

function sameContext(left: SharingContext, right: SharingContext): boolean {
  if (left.kind !== right.kind || left.id !== right.id) return false;
  if (left.kind === "twin" || right.kind === "twin") return true;
  return left.ownerJoinSequence === right.ownerJoinSequence
    && left.recipientJoinSequence === right.recipientJoinSequence;
}

export function hasCurrentResourcePolicyContext(
  db: DatabaseSync, localNodeId: string, statementInput: SignedResourcePolicy,
): boolean {
  ensureResourceSharingSchema(db);
  const statement = signedSchema.parse(statementInput);
  const body = statement.body;
  if (body.operation !== "upsert" || body.recipientNodeId !== localNodeId) return false;
  const state = policyRow(db, body.kind, body.resourceId);
  if (!state || state.deleted || state.owner_node_id !== body.ownerNodeId) return false;
  const [ownerAdmission, recipientAdmission] = admissions(body.context);
  const row = db.prepare(`
    SELECT statement FROM cluster_v2_resource_contexts
    WHERE kind=? AND resource_id=? AND context_kind=? AND context_id=?
      AND owner_admission=? AND recipient_admission=? AND recipient_id=?
      AND generation=? AND active=1
  `).get(
    body.kind, body.resourceId, body.context.kind, body.context.id,
    ownerAdmission, recipientAdmission, localNodeId, body.generation,
  ) as { statement: string } | undefined;
  if (row?.statement !== JSON.stringify(statement)) return false;
  return body.context.kind === "cluster"
    ? clusterContextValid(db, body)
    : twinActive(db, body.context.id, localNodeId, body.ownerNodeId);
}

export function resourcePolicyDeliveryIsCurrent(
  db: DatabaseSync, localInput: string, statementInput: SignedResourcePolicy,
): boolean {
  ensureResourceSharingSchema(db);
  const local = uuid.parse(localInput);
  const statement = signedSchema.parse(statementInput);
  const body = statement.body;
  if (body.ownerNodeId !== local || body.writerNodeId !== local) {
    throw new Error("Foreign resource policy delivery invariant");
  }
  if (body.operation !== "upsert") return true;
  const state = policyRow(db, body.kind, body.resourceId);
  if (!state || state.deleted || state.owner_node_id !== local || state.generation !== body.generation) return false;
  return currentContexts(db, local, body.kind, body.resourceId).some((target) =>
    target.peer === body.recipientNodeId
    && sameContext(target.context, body.context)
    && JSON.stringify(sorted(target.shares)) === JSON.stringify(body.shares));
}

export function listResourcePolicyDeliveries(
  db: DatabaseSync,
): Array<{ operationId: string; peerId: string; statement: SignedResourcePolicy }> {
  ensureResourceSharingSchema(db);
  const rows = db.prepare(`
    SELECT operation_id,peer_id,statement FROM cluster_v2_resource_deliveries
    ORDER BY generation,operation_id,peer_id
  `).all() as unknown as Array<{ operation_id: string; peer_id: string; statement: string }>;
  return rows.map((row) => ({
    operationId: row.operation_id,
    peerId: row.peer_id,
    statement: signedSchema.parse(JSON.parse(row.statement)),
  }));
}
export function acknowledgeResourcePolicyDelivery(
  db: DatabaseSync, operationId: string, peerId: string,
): void {
  ensureResourceSharingSchema(db);
  db.prepare("DELETE FROM cluster_v2_resource_deliveries WHERE operation_id=? AND peer_id=?")
    .run(uuid.parse(operationId), uuid.parse(peerId));
}
