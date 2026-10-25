/* Types shared by both halves of the built-in file sync engine. The worker thread (data plane) and the
   main thread (control plane) agree on these; the messages between them are in protocol.ts. */

export type ShareKind = "project" | "tickets" | "worktrees";
export const SHARE_KINDS: readonly ShareKind[] = ["project", "tickets", "worktrees"];

export interface ShareRef { projectId: string; kind: ShareKind }

export function shareKey(ref: ShareRef): string { return `${ref.kind}:${ref.projectId}`; }

export function parseShareKey(key: string): ShareRef {
  const separator = key.indexOf(":");
  const kind = key.slice(0, separator) as ShareKind;
  const projectId = key.slice(separator + 1);
  if (separator < 1 || !SHARE_KINDS.includes(kind) || !projectId) throw new Error(`Invalid share key: ${key}`);
  return { kind, projectId };
}

/** 0 file, 1 directory, 2 symbolic link. */
export type EntryType = 0 | 1 | 2;
export const FILE: EntryType = 0;
export const DIRECTORY: EntryType = 1;
export const SYMLINK: EntryType = 2;

/** nodeId → that node's clock reading (milliseconds or later) when it produced the version. */
export type Vector = Record<string, number>;

export interface IndexEntry {
  /** NFC, "/"-separated, relative to the share root. */
  path: string;
  /** For a tombstone, the type of the last live version. */
  type: EntryType;
  /** File size; the last live size for a tombstone. */
  size: number;
  mtimeMs: number;
  /** stat.mode & 0o777; 0 for symbolic links. */
  mode: number;
  /** Files only; for a tombstone the hash of the content it deleted ("lastSha"). */
  sha256: string | null;
  /** Symbolic links only (the link text, never followed); kept on tombstones like sha256. */
  target: string | null;
  deleted: boolean;
  version: Vector;
  /** Node that produced this version: conflict tie-break and conflict-copy name. */
  modifiedBy: string;
  /** The sending node's per-share change sequence (paging cursor, not a version). */
  seq: number;
}

export type EngineMode = "syncthing" | "builtin";
/** Node-local progress of a project between engines (FILE-SYNC design §7). Only `builtin` lets the engine write. */
export type Phase = "syncthing" | "releasing" | "bootstrapping" | "builtin" | "restoring";

export interface EngineRecord { projectId: string; mode: EngineMode; generation: number; updatedAt: string; origin: string }

export interface RuleSettings {
  disabledBuiltins: string[];
  userRules: string[];
  /** A user rule is removed from a node's Syncthing ignores only when listed here, never because it is absent. */
  removedUserRules: string[];
  gitignore: boolean;
  /** Nodes whose node-local .stignore user rules are already merged in. */
  importedFrom: string[];
}

export const EMPTY_RULE_SETTINGS: RuleSettings = { disabledBuiltins: [], userRules: [], removedUserRules: [], gitignore: false, importedFrom: [] };

/** Keys: `project:<projectId>` (any node sharing the project) and `global:<nodeId>` (that node only). */
export interface SettingsRecord { key: string; value: RuleSettings; updatedAt: string; origin: string }

export interface Clock {
  now(): number;
  setTimeout(run: () => void, ms: number): { cancel(): void };
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(run, ms) {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  },
};

export type ShareState = "starting" | "scanning" | "idle" | "error" | "unavailable";
