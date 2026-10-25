import { createHash } from "node:crypto";
import { DIRECTORY, FILE, SYMLINK, type IndexEntry } from "./types.js";
import { canonicalVector, compareVectors, mergeVectors, vectorsEqual } from "./vectors.js";

/* What a node does about one path given its own entry and the version its peers hold. Conflicts
   are resolved on the losing side, as Syncthing does: the winner does nothing, the loser keeps its
   content as a conflict copy named from the losing version, so every node holding that loser makes
   the same copy and the copies merge instead of multiplying. */

export type ApplyAction = "fetch" | "delete" | "mkdir" | "symlink" | "meta";
export type Decision =
  | { kind: "none" }
  | { kind: "merge"; version: IndexEntry["version"] }
  | { kind: "apply"; action: ApplyAction; conflict: boolean };

type Content = Pick<IndexEntry, "type" | "sha256" | "target" | "deleted">;
type Meta = Content & Pick<IndexEntry, "mode">;

const NONE: Decision = { kind: "none" };

// Live content equality; an unknown hash or link text never matches anything.
function sameLiveContent(a: Content, b: Content): boolean {
  if (a.type !== b.type) return false;
  if (a.type === FILE) return a.sha256 !== null && a.sha256 === b.sha256;
  if (a.type === SYMLINK) return a.target !== null && a.target === b.target;
  return true;
}

/** Both deleted, or the same type and the same bytes / link text / a directory. Mode is not content. */
export function sameContent(a: Content | undefined, b: Content | undefined): boolean {
  if (!a || !b) return false;
  if (a.deleted || b.deleted) return a.deleted && b.deleted;
  return sameLiveContent(a, b);
}

/** sameContent and the same mode (symlinks have none). */
export function sameMeta(a: Meta | undefined, b: Meta | undefined): boolean {
  return sameContent(a, b) && (a!.deleted || a!.type === SYMLINK || a!.mode === b!.mode);
}

// A tombstone beats a live version only when it deleted exactly that content ("lastSha").
function deletedExactly(tombstone: IndexEntry, live: IndexEntry): boolean {
  return sameLiveContent(tombstone, live);
}

function compareText(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

// Total order behind every tie-break: newer mtime, larger modifiedBy, larger sha256 (null lowest),
// then the remaining fields so that no two distinguishable entries ever tie.
function rank(a: IndexEntry, b: IndexEntry): number {
  return Math.sign(a.mtimeMs - b.mtimeMs)
    || compareText(a.modifiedBy, b.modifiedBy)
    || compareText(a.sha256, b.sha256)
    || compareText(a.target, b.target)
    || a.type - b.type
    || Number(a.deleted) - Number(b.deleted)
    || a.mode - b.mode
    || Math.sign(a.size - b.size)
    || compareText(canonicalVector(a.version), canonicalVector(b.version))
    || Math.sign(a.seq - b.seq)
    || compareText(a.path, b.path);
}

/** The winner of two concurrent versions. 1. live beats deleted, unless the tombstone deleted exactly
    the live content; 2. newer mtimeMs; 3. larger modifiedBy; 4. larger sha256. */
export function conflictWinner(a: IndexEntry, b: IndexEntry): "a" | "b" {
  if (a.deleted !== b.deleted) {
    const tombstoneWins = a.deleted ? deletedExactly(a, b) : deletedExactly(b, a);
    return tombstoneWins === a.deleted ? "a" : "b";
  }
  return rank(a, b) >= 0 ? "a" : "b";
}

/** The version everyone should end up with. A pairwise fold would depend on the order (dominance and
    conflictWinner disagree on some triples), so this works on the set: the versions nothing dominates,
    then conflictWinner's rules over that set. Equals conflictWinner for two concurrent entries. */
export function pickTarget(entries: readonly IndexEntry[]): IndexEntry | undefined {
  const maximal = entries.filter((entry) => !entries.some((other) => compareVectors(other.version, entry.version) === "greater"));
  if (!maximal.length) return undefined;
  const tombstones = maximal.filter((entry) => entry.deleted);
  const survivors = maximal.filter((entry) => !entry.deleted && !tombstones.some((tombstone) => deletedExactly(tombstone, entry)));
  const pool = survivors.length ? survivors : tombstones;
  return pool.reduce((best, entry) => rank(entry, best) > 0 ? entry : best);
}

function applyAction(target: IndexEntry): ApplyAction {
  if (target.deleted) return "delete";
  return target.type === FILE ? "fetch" : target.type === DIRECTORY ? "mkdir" : "symlink";
}

function decideWith(local: IndexEntry | undefined, target: IndexEntry | undefined, targetWins: (local: IndexEntry, target: IndexEntry) => boolean, superseded: boolean): Decision {
  if (!target) return NONE;
  if (local && sameMeta(local, target)) {
    const version = mergeVectors(local.version, target.version);
    // Only a vector the local row does not already cover is worth a write.
    return vectorsEqual(version, local.version) ? NONE : { kind: "merge", version };
  }
  if (local && sameContent(local, target)) {
    const order = compareVectors(target.version, local.version);
    if (order === "greater" || (order === "concurrent" && targetWins(local, target))) return { kind: "apply", action: "meta", conflict: false };
    return NONE;
  }
  if (!local) return target.deleted ? NONE : { kind: "apply", action: applyAction(target), conflict: false };
  const order = compareVectors(target.version, local.version);
  if (order === "greater") return { kind: "apply", action: applyAction(target), conflict: false };
  if (order !== "concurrent" || !targetWins(local, target)) return NONE;
  // A winning tombstone deleted exactly this content and a directory is cleared through the trash:
  // neither leaves anything to keep. Content a peer already replaced is history, not a conflict.
  const keep = !local.deleted && local.type !== DIRECTORY && !target.deleted && !superseded;
  return { kind: "apply", action: applyAction(target), conflict: keep };
}

/** Decision for one path against the target version (FILE-SYNC design §3.4). A concurrent local
    winner does nothing: no bump, the peer resolves as the loser. */
export function decide(local: IndexEntry | undefined, target: IndexEntry | undefined): Decision {
  return decideWith(local, target, (mine, theirs) => conflictWinner(mine, theirs) === "b", false);
}

/** decide() against the target over every known version, the local one included. With three or more
    nodes, decide(local, pickTarget(remotes)) can leave each node preferring a different version
    (conflictWinner is not transitive once dominance is involved); this picks one global target, so
    every node that holds the same rows converges on it. Same result as decide() with one peer. */
export function decideGlobal(local: IndexEntry | undefined, remotes: readonly IndexEntry[]): { target: IndexEntry | undefined; decision: Decision } {
  const target = pickTarget(local ? [...remotes, local] : remotes);
  if (!target || !local) return { target, decision: decide(local, target) };
  if (target === local) {
    // Identical content elsewhere still merges vectors (invariant 3).
    const version = remotes.filter((remote) => sameMeta(local, remote)).reduce((merged, remote) => mergeVectors(merged, remote.version), local.version);
    return { target, decision: vectorsEqual(version, local.version) ? NONE : { kind: "merge", version } };
  }
  const superseded = remotes.some((remote) => compareVectors(remote.version, local.version) === "greater");
  return { target, decision: decideWith(local, target, () => true, superseded) };
}

export const CONFLICT_COPY_LIMIT = 10;
// Same shape as sync-check's conflictOriginalPath and the transcript matcher in harnesses/shared-paths.
const CONFLICT_NAME = /^(.*?)\.sync-conflict-(\d{8}-\d{6})-[A-Z0-9]{7}(.*)$/;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
// Years 1970–9999 keep the stamp at exactly YYYYMMDD-HHMMSS.
const LAST_STAMP_MS = Date.UTC(9999, 11, 31, 23, 59, 59);

function base32(bytes: Uint8Array): string {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  return bits ? output + BASE32[(buffer << (5 - bits)) & 31] : output;
}

/** Syncthing's short device id, derived from a node id: 7 base32 characters of sha256(nodeId). */
export function shortNodeId(nodeId: string): string {
  // 5 bytes are exactly 8 base32 characters, so these 7 equal the start of the full hash's encoding.
  return base32(createHash("sha256").update(nodeId, "utf8").digest().subarray(0, 5)).slice(0, 7);
}

function stamp(mtimeMs: number, bumpSeconds: number): string {
  const seconds = Math.floor(Math.min(Math.max(mtimeMs, 0), LAST_STAMP_MS) / 1000) + bumpSeconds;
  return new Date(Math.min(seconds * 1000, LAST_STAMP_MS)).toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
}

/** `dir/name.sync-conflict-YYYYMMDD-HHMMSS-XXXXXXX.ext`, inserted before the first extension, stamped
    with the losing version's mtime (UTC) and producer, so every node names the same loser alike. */
export function conflictCopyName(relative: string, loser: Pick<IndexEntry, "mtimeMs" | "modifiedBy">, bumpSeconds = 0): string {
  const slash = relative.lastIndexOf("/");
  const directory = relative.slice(0, slash + 1);
  const name = relative.slice(slash + 1);
  const dot = name.indexOf(".", 1);
  const base = dot < 0 ? name : name.slice(0, dot);
  const extension = dot < 0 ? "" : name.slice(dot);
  return `${directory}${base}.sync-conflict-${stamp(loser.mtimeMs, bumpSeconds)}-${shortNodeId(loser.modifiedBy)}${extension}`;
}

/** The original of a conflict copy (relative path), or undefined when `relative` is not one. */
export function conflictCopyOriginal(relative: string): string | undefined {
  const slash = relative.lastIndexOf("/");
  const match = CONFLICT_NAME.exec(relative.slice(slash + 1));
  return match ? `${relative.slice(0, slash + 1)}${match[1]}${match[3]}` : undefined;
}

/** Where the loser's copy goes. `existing` returns the entry already at a candidate path. The same
    content there means the loser is already preserved (drop the local copy); other content moves the
    stamp one second later until a free name turns up. */
export function placeConflictCopy(
  relative: string,
  loser: Pick<IndexEntry, "mtimeMs" | "modifiedBy" | "type" | "sha256" | "target" | "deleted">,
  existing: (candidate: string) => Content | undefined,
): { path: string; preserved: boolean } {
  for (let bumpSeconds = 0; bumpSeconds < 3600; bumpSeconds += 1) {
    const candidate = conflictCopyName(relative, loser, bumpSeconds);
    const there = existing(candidate);
    if (!there || there.deleted) return { path: candidate, preserved: false };
    if (sameContent(there, loser)) return { path: candidate, preserved: true };
  }
  throw new Error(`No free conflict copy name for ${relative}`);
}

/** Copies of `relative` beyond the cap, oldest stamp first (they go to the trash). Pass every copy
    in the directory, the one about to be created included. */
export function conflictCopiesOverLimit(relative: string, candidates: Iterable<string>, limit = CONFLICT_COPY_LIMIT): string[] {
  const copies = [...new Set(candidates)].filter((candidate) => conflictCopyOriginal(candidate) === relative);
  const stampOf = (candidate: string) => CONFLICT_NAME.exec(candidate.slice(candidate.lastIndexOf("/") + 1))![2];
  copies.sort((a, b) => compareText(stampOf(a), stampOf(b)) || compareText(a, b));
  return copies.slice(0, Math.max(0, copies.length - limit));
}
