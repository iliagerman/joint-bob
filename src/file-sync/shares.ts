import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pinnedClusterPublicKey } from "../cluster-identity.js";
import { projectMetadataVisible } from "../cluster-project-metadata.js";
import { projectWorktreeRoot } from "../project-worktrees.js";
import { replicationPeers } from "../server/replication-v2.js";
import { mayShareProject } from "../server/sharing-files.js";
import { ticketWorkspaceRoot } from "../task-workspaces.js";
import { effectiveRuleSettings, effectiveRules } from "./ignore.js";
import type { ShareSpec } from "./protocol.js";
import { parseShareKey, SHARE_KINDS, shareKey, type Phase, type RuleSettings } from "./types.js";

/* Which folders this node syncs, with whom, and under which rules. Derived from node.db by direct
   SQL, never through an acting account: in a member's request other people's projects are hidden,
   yet the engine serves every project the node shares. */

export interface DeriveInput {
  local: string;
  shadowProjects: "all" | readonly string[];
  /** Node-local phase per project; absent means "syncthing" (shadow). */
  phases: ReadonlyMap<string, Phase>;
  /** Settings records by key (`project:<id>`, `global:<nodeId>`). */
  settings: ReadonlyMap<string, RuleSettings>;
  ticketRoot?: string;
  worktreeRoot?: (projectId: string) => string;
}

function safely(check: () => boolean): boolean {
  try { return check(); } catch { return false; }
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

/**
 * Projects with a live policy whose metadata this node may see, that have at least one eligible
 * peer and are in the shadow allowlist (or past it: any phase but "syncthing"). A peer is eligible
 * while mayShareProject holds; it turns false for a while after a restart or a relay disconnect,
 * which only takes the peer out of this snapshot (stop serving and pulling), never the index.
 */
export function deriveShares(db: DatabaseSync, input: DeriveInput): ShareSpec[] {
  if (!tableExists(db, "projects") || !tableExists(db, "cluster_v2_resource_policy")) return [];
  const projects = db.prepare(`SELECT p.id, p.path FROM projects p JOIN cluster_v2_resource_policy r
    ON r.kind = 'project' AND r.resource_id = p.id AND r.deleted = 0 ORDER BY p.id`).all() as Array<{ id: string; path: string }>;
  const allowed = (id: string): boolean => (input.phases.get(id) ?? "syncthing") !== "syncthing"
    || input.shadowProjects === "all" || input.shadowProjects.includes(id);
  const candidates = projects.filter((project) => allowed(project.id));
  if (!candidates.length) return [];
  let peers: string[] = [];
  try { peers = replicationPeers(db, input.local).map((peer) => peer.nodeId); } catch { return []; }
  // A peer whose key is not pinned could never authenticate a request.
  peers = peers.filter((peer) => safely(() => pinnedClusterPublicKey(db, peer) !== undefined)).sort();
  const owners = new Map((db.prepare("SELECT resource_id, owner_node_id FROM sharing_resource_owners WHERE kind = 'project'").all() as Array<{ resource_id: string; owner_node_id: string }>)
    .map((row) => [row.resource_id, row.owner_node_id]));
  let ticketRoot: string | undefined;
  const shares: ShareSpec[] = [];
  for (const project of candidates) {
    if (!safely(() => projectMetadataVisible(db, input.local, project.id))) continue;
    const eligible = peers.filter((peer) => safely(() => mayShareProject(db, input.local, peer, project.id)));
    if (!eligible.length) continue;
    const owner = owners.get(project.id) ?? input.local;
    const projectRules = input.settings.get(`project:${project.id}`);
    const globalRules = input.settings.get(`global:${owner}`);
    const phase = input.phases.get(project.id) ?? "syncthing";
    for (const kind of SHARE_KINDS) {
      let root: string;
      try {
        root = kind === "project" ? project.path
          : kind === "tickets" ? path.join(ticketRoot ??= input.ticketRoot ?? ticketWorkspaceRoot(), project.id)
          : (input.worktreeRoot ?? projectWorktreeRoot)(project.id);
      } catch { continue; }
      shares.push({
        key: shareKey({ projectId: project.id, kind }), projectId: project.id, kind, root, phase,
        rules: effectiveRuleSettings(effectiveRules(kind, projectRules, globalRules)), peers: eligible,
      });
    }
  }
  return shares;
}

/**
 * Shares whose index state goes for good: every share of a project whose policy is deleted, and any
 * known share whose project row is gone. A share that is merely not derived right now (no eligible
 * peer, a relay lease lapsed, out of the shadow list) keeps its index.
 */
export function droppedShares(db: DatabaseSync, known: Iterable<string>): string[] {
  const dropped = new Set<string>();
  if (!tableExists(db, "projects") || !tableExists(db, "cluster_v2_resource_policy")) return [];
  for (const { id } of db.prepare("SELECT resource_id id FROM cluster_v2_resource_policy WHERE kind = 'project' AND deleted = 1").all() as Array<{ id: string }>) {
    for (const kind of SHARE_KINDS) dropped.add(shareKey({ projectId: id, kind }));
  }
  const row = db.prepare("SELECT 1 FROM projects WHERE id = ?");
  for (const key of known) {
    let projectId: string;
    try { projectId = parseShareKey(key).projectId; } catch { continue; }
    if (!row.get(projectId)) dropped.add(key);
  }
  return [...dropped].sort();
}

/** The share holding a path: the deepest root that contains it (roots can nest, e.g. a project inside the home folder). */
export function shareContaining(shares: readonly ShareSpec[], target: string): { share: ShareSpec; subtree?: string } | undefined {
  const resolved = path.resolve(target);
  let best: { share: ShareSpec; subtree?: string } | undefined;
  for (const share of shares) {
    const relative = path.relative(path.resolve(share.root), resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    if (best && path.resolve(best.share.root).length >= path.resolve(share.root).length) continue;
    best = { share, ...(relative ? { subtree: relative.split(path.sep).join("/") } : {}) };
  }
  return best;
}

const HOST_ID = /^[A-Za-z0-9-]{8,128}$/;

/**
 * A per-machine id, kept outside the data directory: two nodes that share one machine (dev nodes, a
 * restored copy) have different data directories but the same host id, which lets the same-folder
 * guard tell that a peer's root is literally this node's root.
 */
export function fileSyncHostId(home = os.homedir()): string {
  const file = path.join(home, ".joint-bob-host-id");
  const read = (): string | undefined => {
    try { const value = readFileSync(file, "utf8").trim(); return HOST_ID.test(value) ? value : undefined; } catch { return undefined; }
  };
  const existing = read();
  if (existing) return existing;
  const id = randomUUID();
  try {
    writeFileSync(file, `${id}\n`, { flag: "wx", mode: 0o600 });
    return id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  // Another process created it first, or it holds something unusable: keep a valid one, replace the rest.
  const raced = read();
  if (raced) return raced;
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${id}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  return read() ?? id;
}
