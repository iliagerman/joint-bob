import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { mayShareProject } from "../server/sharing-files.js";
import { saveEngineRecord, saveSettingsRecord } from "./control.js";
import type { EngineRecord, SettingsRecord } from "./types.js";
import { nodeIdSchema, projectIdSchema } from "./wire.js";

/* Records a peer's engine sent in its /files/shares answer (design §6.4), checked before they reach
   node.db. The worker forwards them with the peer that signed the answer; a peer also passes on
   records it got from others, and those are dropped here on purpose: an engine record counts only
   from the project's owner, a settings record only from the node that wrote it, so a peer can
   neither switch someone else's project nor speak for another node. */

/** A clock this far ahead of ours would let one record win every later write. Signed requests already need ±60 s. */
const MAX_FUTURE_MS = 10 * 60_000;

/** Ordering compares these strings, so only the canonical toISOString form is accepted (an offset form would sort wrongly). */
const timestamp = z.string().refine((value) => {
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString() === value;
}, "Not a canonical timestamp");
const ruleList = z.array(z.string().max(1000)).max(1000);
const engineRecordSchema = z.object({ projectId: projectIdSchema, mode: z.enum(["syncthing", "builtin"]), generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), updatedAt: timestamp, origin: nodeIdSchema });
const settingsRecordSchema = z.object({
  key: z.string().regex(/^(project|global):.{1,240}$/),
  value: z.object({ disabledBuiltins: ruleList, userRules: ruleList, removedUserRules: ruleList, gitignore: z.boolean(), importedFrom: z.array(nodeIdSchema).max(1000) }),
  updatedAt: timestamp,
  origin: nodeIdSchema,
});

export interface ReceivedRecords { fromPeer: string; engines: readonly unknown[]; settings: readonly unknown[] }

export interface RecordsOutcome {
  /** Records stored because they were newer than the ones held. */
  engines: number;
  settings: number;
  /** Records refused, with why; a relayed record is routine, not a fault. */
  rejected: Array<{ record: string; reason: string }>;
}

export interface AcceptOptions {
  now?: number;
  /** Whether `peer` may hold project `projectId` with this node (sharing policy); errors count as no. */
  mayShare?: (peer: string, projectId: string) => boolean;
}

function projectOwner(db: DatabaseSync, projectId: string): string | undefined {
  try {
    const row = db.prepare("SELECT owner_node_id FROM sharing_resource_owners WHERE kind = 'project' AND resource_id = ?").get(projectId) as { owner_node_id: string } | undefined;
    return row?.owner_node_id;
  } catch { return undefined; }
}

function engineProblem(db: DatabaseSync, local: string, fromPeer: string, record: EngineRecord): string | undefined {
  const owner = projectOwner(db, record.projectId);
  if (!owner) return "project has no known owner here";
  if (owner === local) return "this node owns the project";
  if (fromPeer !== owner) return "sender is not the project's owner";
  if (record.origin !== owner) return "record was not written by the project's owner";
  return undefined;
}

function settingsProblem(fromPeer: string, record: SettingsRecord, mayShare: (peer: string, projectId: string) => boolean): string | undefined {
  if (record.origin !== fromPeer) return "record was not written by its sender";
  const separator = record.key.indexOf(":");
  const scope = record.key.slice(0, separator), subject = record.key.slice(separator + 1);
  // A node's "All projects" level is written by that node alone.
  if (scope === "global") return subject === fromPeer ? undefined : "another node's global rules";
  return mayShare(fromPeer, subject) ? undefined : "sender does not share the project with this node";
}

/** Validates and stores what one peer sent, in one transaction; never throws for a bad record. */
export function acceptRecords(db: DatabaseSync, local: string, received: ReceivedRecords, options: AcceptOptions = {}): RecordsOutcome {
  const outcome: RecordsOutcome = { engines: 0, settings: 0, rejected: [] };
  const now = options.now ?? Date.now();
  const mayShare = options.mayShare ?? ((peer: string, projectId: string) => {
    try { return mayShareProject(db, local, peer, projectId); } catch { return false; }
  });
  const reject = (record: string, reason: string) => { outcome.rejected.push({ record, reason }); };
  const fromPeer = received.fromPeer;
  if (fromPeer === local || !nodeIdSchema.safeParse(fromPeer).success) { reject("*", "not from a peer"); return outcome; }
  const future = (updatedAt: string) => Date.parse(updatedAt) > now + MAX_FUTURE_MS;
  db.exec("SAVEPOINT file_sync_records");
  try {
    for (const value of received.engines) {
      const parsed = engineRecordSchema.safeParse(value);
      if (!parsed.success) { reject("engine", "invalid record"); continue; }
      const record = parsed.data, label = `engine:${record.projectId}`;
      const problem = engineProblem(db, local, fromPeer, record) ?? (future(record.updatedAt) ? "written in the future" : undefined);
      if (problem) { reject(label, problem); continue; }
      if (saveEngineRecord(db, record)) outcome.engines++;
    }
    for (const value of received.settings) {
      const parsed = settingsRecordSchema.safeParse(value);
      if (!parsed.success) { reject("settings", "invalid record"); continue; }
      const record = parsed.data;
      const problem = settingsProblem(fromPeer, record, mayShare) ?? (future(record.updatedAt) ? "written in the future" : undefined);
      if (problem) { reject(record.key, problem); continue; }
      if (saveSettingsRecord(db, record)) outcome.settings++;
    }
    db.exec("RELEASE file_sync_records");
  } catch (error) {
    db.exec("ROLLBACK TO file_sync_records; RELEASE file_sync_records");
    throw error;
  }
  return outcome;
}
