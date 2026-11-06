import type { DatabaseSync } from "node:sqlite";
import { getClusterNode } from "../cluster.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { ownerAsActor } from "../ownership.js";
import { enqueueReplicationEvent, ensureReplicationSchema, resolveProjectAlias, type ReplicationEvent } from "../replication.js";
import { bobDatabase, bobSettingsUpdatedAt, ensureBobSchema, onBobAccountChanged, readBobSettings, storeBobAccount, storeBobSettings, type BobSettings } from "./bob-store.js";
import { onReviewCheckWritten, readReviewCheck, storeReviewCheck, type ReviewCheck } from "./review-check.js";

/**
 * What Bob needs on each of the person's machines to watch their conversations there: that they use Bob, with the settings they
 * chose (pausing Bob on one machine pauses him on all), and what his checks found, so every machine's board shows it. The newest
 * write wins; an event that arrives here is kept and not sent on again.
 */
export const BOB_EVENT = "control.bob";
export const REVIEW_CHECK_EVENT = "control.reviewCheck";

const MAX_ID = 240;
const text = (value: unknown, limit: number): value is string => typeof value === "string" && value.length >= 1 && value.length <= limit;
const time = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

export function publishBobAccount(db: DatabaseSync, originNodeId: string, accountId: string): void {
  ensureReplicationSchema(db);
  const updatedAt = bobSettingsUpdatedAt(db, accountId) ?? new Date(0).toISOString();
  enqueueReplicationEvent(db, { originNodeId, entityType: BOB_EVENT, entityKey: accountId, operation: "upsert", payload: { accountId, settings: readBobSettings(db, accountId), updatedAt } });
}

export function applyBobEvent(db: DatabaseSync, event: ReplicationEvent): void {
  const value = event.payload as Record<string, unknown> | null;
  if (!value || !text(value.accountId, MAX_ID) || event.entityKey !== value.accountId || !value.settings || typeof value.settings !== "object" || !time(value.updatedAt)) {
    throw new Error("Malformed Bob replication payload");
  }
  ensureBobSchema(db);
  const actor = ownerAsActor(value.accountId);
  if (!actor) throw new Error("Bob replication names no account");
  storeBobAccount(db, actor);
  const held = bobSettingsUpdatedAt(db, value.accountId);
  if (!held || value.updatedAt > held) storeBobSettings(db, value.accountId, value.settings as Partial<BobSettings>, value.updatedAt);
}

export function publishReviewCheck(db: DatabaseSync, originNodeId: string, check: ReviewCheck): void {
  ensureReplicationSchema(db);
  enqueueReplicationEvent(db, { originNodeId, entityType: REVIEW_CHECK_EVENT, entityKey: `${check.projectId}:${check.conversationId}`, operation: "upsert", payload: { ...check } });
}

export function applyReviewCheckEvent(db: DatabaseSync, event: ReplicationEvent): void {
  const value = event.payload as Partial<ReviewCheck> | null;
  if (!value || !text(value.projectId, MAX_ID) || !text(value.conversationId, MAX_ID) || !text(value.accountId, MAX_ID)
    || !["done", "continue", "needs-user"].includes(String(value.verdict)) || typeof value.reason !== "string" || value.reason.length > 1_000
    || typeof value.by !== "string" || value.by.length > 200 || !text(value.answerHash, 128) || !Number.isInteger(value.pushes)
    || typeof value.pushPending !== "boolean" || typeof value.needsYou !== "boolean" || !time(value.checkedAt)
    || event.entityKey !== `${value.projectId}:${value.conversationId}`) {
    throw new Error("Malformed Bob review check replication payload");
  }
  // Each machine knows a project under its own id.
  const check = { ...value, projectId: resolveProjectAlias(db, value.projectId) } as ReviewCheck;
  const held = readReviewCheck(db, check.projectId, check.conversationId);
  if (!held || check.checkedAt > held.checkedAt) storeReviewCheck(db, check);
}

let started = false;

export function startBobSync(): void {
  if (started) return;
  started = true;
  const send = (work: (db: DatabaseSync, nodeId: string) => void) => {
    void (async () => work(await clusterV2Database(), (await getClusterNode()).id))()
      .catch((error) => console.warn("Bob could not tell your other machines", error instanceof Error ? error.message : error));
  };
  onBobAccountChanged((accountId) => send((db, nodeId) => publishBobAccount(db, nodeId, accountId)));
  onReviewCheckWritten((check) => send((db, nodeId) => publishReviewCheck(db, nodeId, check)));
  // Settings and checks kept before this machine could send them reach the other machines once.
  void bobDatabase().then((db) => send((sendDb, nodeId) => {
    for (const row of db.prepare("SELECT account_id FROM control_center_bob_accounts").all() as Array<{ account_id: string }>) publishBobAccount(sendDb, nodeId, row.account_id);
  })).catch((error) => console.warn("Bob could not tell your other machines", error instanceof Error ? error.message : error));
}
