import type { ProjectSyncStatus } from "../types.js";
import type { CoreEvent, ShareSpec, ShareStatus } from "./protocol.js";

/* What the worker last reported about each share, kept in memory on the main thread so status
   requests never wait for the worker. */

export class ShareStatusStore {
  private readonly statuses = new Map<string, ShareStatus>();

  /** Takes shareState and shareRemoved events; returns whether anything changed. */
  apply(event: CoreEvent): boolean {
    if (event.event === "shareState") { this.statuses.set(event.status.share, event.status); return true; }
    if (event.event === "shareRemoved") return this.statuses.delete(event.share);
    return false;
  }

  get(share: string): ShareStatus | undefined { return this.statuses.get(share); }

  /** Shares the worker has reported, derived or not. */
  keys(): string[] { return [...this.statuses.keys()]; }

  /** Drops reports for shares that are no longer derived. */
  retain(shares: ReadonlySet<string>): void {
    for (const share of this.statuses.keys()) if (!shares.has(share)) this.statuses.delete(share);
  }

  clear(): void { this.statuses.clear(); }

  /** One entry per derived share, in their order; a share the worker has not reported yet reads as starting. */
  list(shares: readonly ShareSpec[]): ShareStatus[] {
    return shares.map((spec) => this.statuses.get(spec.key) ?? startingStatus(spec));
  }
}

export function startingStatus(spec: ShareSpec): ShareStatus {
  return {
    share: spec.key, projectId: spec.projectId, kind: spec.kind, state: "starting", phase: spec.phase,
    maxSeq: 0, indexId: "", digest: "", rulesHash: "", liveFiles: 0, liveBytes: 0, need: { files: 0, bytes: 0 },
    blocked: 0, errors: 0, scanning: false, watch: "off", message: "Starting file sync", peers: [],
  };
}

function plural(count: number, one: string, many = `${one}s`): string { return `${count} ${count === 1 ? one : many}`; }

function errorMessage(share: ShareStatus): string {
  if (share.blocked) return `${plural(share.blocked, "file")} could not be synchronized`;
  if (share.errors) return `${plural(share.errors, "file")} could not be read or written`;
  return share.message ?? "File sync stopped on an error";
}

/**
 * A built-in project's status from its shares' reports (design §6.5). Error wins over unavailable,
 * unavailable over syncing, syncing over synced. `peerProblem` names an eligible peer that cannot
 * receive files (engine off or too old there).
 */
export function projectSyncStatus(shares: readonly ShareStatus[], engine: { enabled: boolean; running: boolean; present?: (peer: string) => boolean }, peerProblem?: string): ProjectSyncStatus {
  const present = engine.present ?? (() => true);
  const remainingFiles = shares.reduce((sum, share) => sum + share.need.files, 0);
  const remainingBytes = shares.reduce((sum, share) => sum + share.need.bytes, 0);
  const status = (state: ProjectSyncStatus["state"], message: string): ProjectSyncStatus => ({ state, remainingFiles, remainingBytes, message });
  if (!engine.enabled) return status("unavailable", "File sync is off on this node");
  const failed = shares.find((share) => share.state === "error" || share.blocked > 0 || share.errors > 0);
  if (failed) return status("error", errorMessage(failed));
  if (peerProblem) return status("error", peerProblem);
  const missing = shares.find((share) => share.state === "unavailable");
  if (missing) return status("unavailable", missing.message ?? "The folder is missing on this node");
  if (!engine.running || !shares.length || shares.some((share) => share.state === "starting")) return status("syncing", "Starting file sync");
  if (shares.some((share) => share.scanning || share.state === "scanning")) return status("syncing", "Checking files");
  if (remainingFiles > 0) return status("syncing", `${plural(remainingFiles, "file")} to receive`);
  // An away peer's newer files cannot arrive until it is back; waiting for it is not syncing.
  if (shares.some((share) => share.peers.some((peer) => !peer.caughtUp && present(peer.peer)))) return status("syncing", "Catching up with other machines");
  return status("synced", "Files are up to date");
}
