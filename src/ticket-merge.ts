import type { Stats } from "node:fs";

export type { Stats };

/**
 * Pure three-way merge decisions for a ticket workspace, per plan §5 of
 * TICKET-MERGE-PLAN.md. No I/O: the caller scans and hashes the three trees
 * (baseline, workspace, project) and passes the states in. byte-for-byte
 * equality is a hash equality here because the caller hashed the bytes.
 */

export interface FileState {
  path: string;
  sha256: string;
  mode: number;
  symlink?: boolean;
}

export type ChoiceReason = "both-binary" | "edit-vs-delete" | "delete-vs-edit" | "both-created" | "no-baseline" | "mode-conflict";

export type Decision =
  | { kind: "skip"; path: string }
  | { kind: "apply"; path: string }
  | { kind: "delete"; path: string }
  | { kind: "keep-project"; path: string }
  | { kind: "choice"; path: string; reason: ChoiceReason }
  | { kind: "text"; path: string }
  | { kind: "unmergeable"; path: string; reason: "symlink" | "special" };

export interface DecideOptions {
  /** Paths that are safe to line-merge: decodable UTF-8 and within the size limit, on all three sides. */
  textMergeable: Set<string>;
  /** Legacy tickets captured no baseline: every divergent file becomes an explicit
   * choice instead of an automatic apply, because there is no trusted common
   * ancestor to three-way against. */
  legacy?: boolean;
}

export function decide(
  baseline: Map<string, FileState>,
  workspace: Map<string, FileState>,
  project: Map<string, FileState>,
  options: DecideOptions,
): Decision[] {
  const paths = new Set([...baseline.keys(), ...workspace.keys(), ...project.keys()]);
  const decisions: Decision[] = [];
  for (const path of paths) {
    const base = baseline.get(path);
    const work = workspace.get(path);
    const proj = project.get(path);

    if (work?.symlink || proj?.symlink || base?.symlink) {
      decisions.push({ kind: "unmergeable", path, reason: "symlink" });
      continue;
    }

    if (!base) {
      // Created after the baseline was captured (or a legacy ticket with no baseline at all).
      if (work && proj) {
        if (work.sha256 === proj.sha256 && work.mode === proj.mode) decisions.push({ kind: "skip", path });
        else if (work.sha256 === proj.sha256) decisions.push({ kind: "choice", path, reason: "mode-conflict" });
        else decisions.push({ kind: "choice", path, reason: "both-created" });
      }
      else if (work) decisions.push(options.legacy ? { kind: "choice", path, reason: "no-baseline" } : { kind: "apply", path });
      else decisions.push({ kind: "skip", path });
      continue;
    }

    if (!work) {
      // Deleted in the workspace; a project chmod alone still conflicts.
      if (!proj) decisions.push({ kind: "skip", path });
      else if (proj.sha256 === base.sha256 && proj.mode === base.mode) decisions.push({ kind: "delete", path });
      else decisions.push({ kind: "choice", path, reason: "edit-vs-delete" });
      continue;
    }

    if (!proj) {
      // Deleted in the project; a workspace chmod alone still conflicts.
      if (work.sha256 === base.sha256 && work.mode === base.mode) decisions.push({ kind: "skip", path });
      else decisions.push({ kind: "choice", path, reason: "delete-vs-edit" });
      continue;
    }

    // Modes participate: a chmod the agent made is a real change to merge back.
    const workChanged = work.sha256 !== base.sha256 || work.mode !== base.mode;
    const projChanged = proj.sha256 !== base.sha256 || proj.mode !== base.mode;
    if (!workChanged && !projChanged) decisions.push({ kind: "skip", path });
    else if (workChanged && !projChanged) decisions.push({ kind: "apply", path });
    else if (!workChanged && projChanged) decisions.push({ kind: "keep-project", path });
    else if (work.sha256 === proj.sha256 && work.mode === proj.mode) decisions.push({ kind: "skip", path });
    // Divergent modes never merge silently: a text merge cannot pick a mode, so
    // the pair becomes an explicit choice even when the content lines merge.
    else if (work.mode !== proj.mode) decisions.push({ kind: "choice", path, reason: "mode-conflict" });
    else if (work.sha256 === base.sha256 && proj.sha256 === base.sha256) decisions.push({ kind: "choice", path, reason: "both-binary" });
    else if (options.textMergeable.has(path)) decisions.push({ kind: "text", path });
    else decisions.push({ kind: "choice", path, reason: "both-binary" });
  }
  decisions.sort((left, right) => left.path.localeCompare(right.path));
  return decisions;
}
