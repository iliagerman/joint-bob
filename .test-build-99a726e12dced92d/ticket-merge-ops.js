import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { diff3Merge } from "node-diff3";
import { decide } from "./ticket-merge.js";
import { copyAllowed, listTreeEntries, TICKET_BASELINE_DIR, TICKET_MERGE_DIR } from "./task-workspaces.js";
const TEXT_MERGE_LIMIT = 1024 * 1024;
const MARKER_SYNTAX = /^(<{7,}|={7,}|>{7,}|\|{7,})( |$)/;
const MARKER_TAG = "JB-MERGE";
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function utf8Decodable(bytes) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
function entryIdFor(filePath) {
  return sha256(Buffer.from(filePath, "utf8")).slice(0, 12);
}
function markerSyntaxLines(text) {
  return text.split("\n").filter((line) => MARKER_SYNTAX.test(line));
}
function multisetContained(newLines, allowed) {
  const counts = /* @__PURE__ */ new Map();
  for (const line of allowed) counts.set(line, (counts.get(line) ?? 0) + 1);
  for (const line of newLines) {
    const left = counts.get(line) ?? 0;
    if (left === 0) return false;
    counts.set(line, left - 1);
  }
  return true;
}
async function assertPathContained(root, relativePath) {
  const segments = relativePath.split("/");
  if (!segments.length || segments.some((segment) => !segment || segment === "." || segment === "..")) throw new Error(`Invalid merge path: ${relativePath}`);
  let current = await fs.realpath(root);
  for (const segment of segments) {
    const candidate = path.join(current, segment);
    let info = null;
    try {
      info = await fs.lstat(candidate);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return;
    }
    if (info.isSymbolicLink()) throw new Error(`Merge path crosses a symlink: ${relativePath}`);
    current = await fs.realpath(candidate);
  }
  const relative = path.relative(await fs.realpath(root), current);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Merge path escapes the root: ${relativePath}`);
}
async function stagedPathFor(workspace, relativePath) {
  const stagedRoot = path.join(workspace, TICKET_MERGE_DIR, "staged");
  await assertPathContained(stagedRoot, relativePath);
  return path.join(stagedRoot, relativePath);
}
async function scanTree(root, skipTopLevel = [], allowed = copyAllowed) {
  const skip = new Set(skipTopLevel);
  const states = /* @__PURE__ */ new Map();
  const rootPath = path.resolve(root);
  let entries;
  try {
    entries = await listTreeEntries(root);
  } catch (error) {
    if (error.code === "ENOENT") return states;
    throw error;
  }
  for (const entry of entries) {
    const top = path.relative(root, entry.path).split(path.sep)[0];
    if (top && skip.has(top)) continue;
    const filePath = entry.path;
    if (!allowed(rootPath, filePath)) continue;
    const relative = path.relative(root, filePath).split(path.sep).join("/");
    if (entry.symlink) {
      states.set(relative, { path: relative, sha256: "", mode: 0, symlink: true });
      continue;
    }
    const [bytes, info] = await Promise.all([fs.readFile(filePath), fs.stat(filePath)]);
    states.set(relative, { path: relative, sha256: sha256(bytes), mode: info.mode & 4095 });
  }
  return states;
}
async function readBaseline(workspace) {
  let raw;
  try {
    raw = await fs.readFile(path.join(workspace, TICKET_BASELINE_DIR, "manifest.json"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return { manifest: JSON.parse(raw), digest: sha256(Buffer.from(raw, "utf8")) };
}
function baselineStates(manifest) {
  const states = /* @__PURE__ */ new Map();
  for (const [filePath, entry] of Object.entries(manifest.files)) {
    if ("symlink" in entry) states.set(filePath, { path: filePath, sha256: "", mode: 0, symlink: true });
    else states.set(filePath, { path: filePath, sha256: entry.sha256, mode: entry.mode });
  }
  return states;
}
function mergeText(entryId, workspaceText, baselineText, projectText) {
  const workspaceLines = workspaceText.split("\n");
  const baselineLines = baselineText.split("\n");
  const projectLines = projectText.split("\n");
  const regions = diff3Merge(workspaceLines, baselineLines, projectLines, { excludeFalseConflicts: true });
  const out = [];
  let conflicted = false;
  const markerLines = [];
  const push = (line) => {
    out.push(line);
  };
  for (const region of regions) {
    if ("ok" in region || !region.conflict) {
      for (const line of region.ok ?? []) push(line);
      continue;
    }
    conflicted = true;
    const tag = `${MARKER_TAG} ${entryId}`;
    const start = `<<<<<<< ${tag} `;
    const base = `||||||| ${tag} `;
    const mid = `======= ${tag} `;
    const end = `>>>>>>> ${tag} `;
    push(start);
    for (const line of region.conflict.a) push(line);
    push(base);
    for (const line of region.conflict.o) push(line);
    push(mid);
    for (const line of region.conflict.b) push(line);
    push(end);
    markerLines.push(start, base, mid, end);
  }
  const text = out.join("\n");
  return conflicted ? { merged: null, staged: text } : { merged: text, staged: text };
}
async function prepareTicketMerge(projectRoot, workspace, trustedBaselineDigest, options = {}) {
  const baseline = await readBaseline(workspace);
  let baselineTrusted = baseline !== null && trustedBaselineDigest !== void 0 && trustedBaselineDigest === baseline.digest;
  if (baselineTrusted && baseline) {
    for (const [filePath, entry] of Object.entries(baseline.manifest.files)) {
      if ("symlink" in entry) continue;
      const current = await sha256File(path.join(workspace, TICKET_BASELINE_DIR, filePath));
      if (current !== entry.sha256) {
        baselineTrusted = false;
        break;
      }
    }
  }
  const baseStates = baselineTrusted && baseline ? baselineStates(baseline.manifest) : /* @__PURE__ */ new Map();
  const workspaceStates = await scanTree(workspace, [TICKET_BASELINE_DIR, TICKET_MERGE_DIR, ...options.workspaceOnlyDirs ?? []], options.allowed);
  const projectStates = await scanTree(projectRoot, [], options.allowed);
  const textMergeable = /* @__PURE__ */ new Set();
  const bytesFor = async (root, filePath) => {
    try {
      return await fs.readFile(path.join(root, filePath));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  };
  const preliminary = decide(baseStates, workspaceStates, projectStates, { textMergeable: /* @__PURE__ */ new Set() });
  for (const decision of preliminary) {
    if (decision.kind !== "choice" || decision.reason !== "both-binary") continue;
    const [workBytes, baseBytes, projBytes] = await Promise.all([
      bytesFor(workspace, decision.path),
      baselineTrusted ? bytesFor(workspace, path.join(TICKET_BASELINE_DIR, decision.path)) : Promise.resolve(null),
      bytesFor(projectRoot, decision.path)
    ]);
    if (!workBytes || !baseBytes || !projBytes) continue;
    if (workBytes.length > TEXT_MERGE_LIMIT || baseBytes.length > TEXT_MERGE_LIMIT || projBytes.length > TEXT_MERGE_LIMIT) continue;
    if (utf8Decodable(workBytes) && utf8Decodable(baseBytes) && utf8Decodable(projBytes)) textMergeable.add(decision.path);
  }
  const decisions = decide(baseStates, workspaceStates, projectStates, { textMergeable, legacy: !baselineTrusted });
  const stagedRoot = path.join(workspace, TICKET_MERGE_DIR, "staged");
  await fs.rm(path.join(workspace, TICKET_MERGE_DIR), { recursive: true, force: true });
  await fs.mkdir(stagedRoot, { recursive: true });
  const files = {};
  const conflicts = [];
  const unmergeable = [];
  for (const decision of decisions) {
    if (decision.kind === "skip" || decision.kind === "keep-project") {
      files[decision.path] = { decision: decision.kind, projectSha256: projectStates.get(decision.path)?.sha256 ?? null, workspaceSha256: workspaceStates.get(decision.path)?.sha256 ?? null, projectMode: projectStates.get(decision.path)?.mode ?? null, workspaceMode: workspaceStates.get(decision.path)?.mode ?? null };
      continue;
    }
    if (decision.kind === "unmergeable") {
      unmergeable.push(decision.path);
      const workBytes2 = await fs.readFile(path.join(workspace, decision.path)).catch(() => null);
      const projBytes2 = await fs.readFile(path.join(projectRoot, decision.path)).catch(() => null);
      conflicts.push({
        path: decision.path,
        kind: "choice",
        reason: "unmergeable-symlink",
        choices: { workspace: workBytes2 ? sha256(workBytes2) : "", project: projBytes2 ? sha256(projBytes2) : null }
      });
      files[decision.path] = { decision: "choice", projectSha256: projBytes2 ? sha256(projBytes2) : null, workspaceSha256: workBytes2 ? sha256(workBytes2) : null };
      continue;
    }
    if (decision.kind === "delete") {
      files[decision.path] = { decision: "delete", projectSha256: projectStates.get(decision.path)?.sha256 ?? null, workspaceSha256: null, projectMode: projectStates.get(decision.path)?.mode ?? null, workspaceMode: null };
      continue;
    }
    if (decision.kind === "apply") {
      const bytes = await fs.readFile(path.join(workspace, decision.path));
      const target = await stagedPathFor(workspace, decision.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes, { mode: workspaceStates.get(decision.path)?.mode ?? 420 });
      files[decision.path] = { decision: "apply", stagedSha256: sha256(bytes), projectSha256: projectStates.get(decision.path)?.sha256 ?? null, workspaceSha256: workspaceStates.get(decision.path)?.sha256 ?? null, projectMode: projectStates.get(decision.path)?.mode ?? null, workspaceMode: workspaceStates.get(decision.path)?.mode ?? null, mode: workspaceStates.get(decision.path)?.mode };
      continue;
    }
    if (decision.kind === "text") {
      if (!baselineTrusted) continue;
      const [workBytes2, baseBytes, projBytes2] = await Promise.all([
        fs.readFile(path.join(workspace, decision.path)),
        fs.readFile(path.join(workspace, TICKET_BASELINE_DIR, decision.path)),
        fs.readFile(path.join(projectRoot, decision.path))
      ]);
      const entryId = entryIdFor(decision.path);
      const { merged, staged } = mergeText(entryId, workBytes2.toString("utf8"), baseBytes.toString("utf8"), projBytes2.toString("utf8"));
      const stagedBytes = Buffer.from(merged ?? staged, "utf8");
      const target = await stagedPathFor(workspace, decision.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, stagedBytes, { mode: workspaceStates.get(decision.path)?.mode ?? 420 });
      files[decision.path] = { decision: "text", stagedSha256: sha256(stagedBytes), projectSha256: projectStates.get(decision.path)?.sha256 ?? null, workspaceSha256: workspaceStates.get(decision.path)?.sha256 ?? null, projectMode: projectStates.get(decision.path)?.mode ?? null, workspaceMode: workspaceStates.get(decision.path)?.mode ?? null, mode: workspaceStates.get(decision.path)?.mode };
      if (merged === null) {
        conflicts.push({
          path: decision.path,
          kind: "text",
          unresolvedSha256: sha256(stagedBytes),
          markerLines: markerSyntaxLines(staged).length ? markerSyntaxLinesOf(decision, entryId) : [],
          preExistingMarkerLines: [...markerSyntaxLines(workBytes2.toString("utf8"))]
        });
      }
      continue;
    }
    const workBytes = await fs.readFile(path.join(workspace, decision.path)).catch(() => null);
    const projBytes = await fs.readFile(path.join(projectRoot, decision.path)).catch(() => null);
    const workMode = workBytes ? (await fs.stat(path.join(workspace, decision.path))).mode & 4095 : null;
    conflicts.push({
      path: decision.path,
      kind: "choice",
      reason: decision.reason,
      choices: {
        workspace: workBytes ? sha256(workBytes) : "",
        project: projBytes ? sha256(projBytes) : null,
        workspaceMode: workMode,
        projectMode: projBytes ? (await fs.stat(path.join(projectRoot, decision.path))).mode & 4095 : null
      }
    });
    files[decision.path] = { decision: "choice", projectSha256: projBytes ? sha256(projBytes) : null, workspaceSha256: workBytes ? sha256(workBytes) : null, projectMode: projBytes ? (await fs.stat(path.join(projectRoot, decision.path))).mode & 4095 : null, workspaceMode: workMode, ...workMode !== null ? { mode: workMode } : {} };
  }
  const plan = { version: 1, files, unmergeable };
  const planJson = `${JSON.stringify(plan, null, 2)}
`;
  const conflictsJson = `${JSON.stringify({ version: 1, conflicts }, null, 2)}
`;
  await fs.writeFile(path.join(workspace, TICKET_MERGE_DIR, "plan.json"), planJson);
  await fs.writeFile(path.join(workspace, TICKET_MERGE_DIR, "conflicts.json"), conflictsJson);
  return {
    plan,
    conflicts,
    digests: { plan: sha256(Buffer.from(planJson, "utf8")), conflicts: sha256(Buffer.from(conflictsJson, "utf8")), baseline: baseline?.digest ?? "" },
    conflictPaths: conflicts.map((conflict) => conflict.path)
  };
}
function markerSyntaxLinesOf(decision, entryId) {
  const tag = `${MARKER_TAG} ${entryId}`;
  return [`<<<<<<< ${tag} `, `||||||| ${tag} `, `======= ${tag} `, `>>>>>>> ${tag} `];
}
async function validateStagedConflicts(workspace, conflicts) {
  const stagedRoot = path.join(workspace, TICKET_MERGE_DIR, "staged");
  const resolved = [];
  const remaining = [];
  const validated = /* @__PURE__ */ new Map();
  for (const entry of conflicts) {
    const stagedPath = path.join(stagedRoot, entry.path);
    let bytes = null;
    try {
      bytes = await fs.readFile(stagedPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (entry.kind === "choice") {
      if (!bytes) {
        remaining.push(entry);
        continue;
      }
      const hash = sha256(bytes);
      const stagedMode = (await fs.stat(stagedPath)).mode & 4095;
      const workspaceChoice = entry.choices?.workspace ?? "";
      const projectChoice = entry.choices?.project ?? null;
      const matchesWorkspace = hash === workspaceChoice && workspaceChoice !== "" && stagedMode === (entry.choices?.workspaceMode ?? stagedMode);
      const matchesProject = projectChoice !== null && projectChoice !== "" && hash === projectChoice && stagedMode === (entry.choices?.projectMode ?? stagedMode);
      if (matchesWorkspace || matchesProject) {
        resolved.push(entry);
        validated.set(entry.path, { sha256: hash, mode: stagedMode });
      } else remaining.push(entry);
      continue;
    }
    if (!bytes || !entry.unresolvedSha256 || sha256(bytes) === entry.unresolvedSha256) {
      remaining.push(entry);
      continue;
    }
    const text = bytes.toString("utf8");
    const markersGone = (entry.markerLines ?? []).every((line) => !text.split("\n").includes(line));
    const noNewSyntax = multisetContained(markerSyntaxLines(text), entry.preExistingMarkerLines ?? []);
    const entryTag = (entry.markerLines?.[0] ?? "").trim().replace(/^<{7,} /, "");
    const noTag = !entryTag || !text.includes(entryTag);
    if (markersGone && noNewSyntax && noTag) {
      resolved.push(entry);
      validated.set(entry.path, { sha256: sha256(bytes), mode: (await fs.stat(stagedPath)).mode & 4095 });
    } else remaining.push(entry);
  }
  return { resolved, remaining, validated };
}
async function resolveChoiceConflict(workspace, conflicts, projectRoot, conflictPath, side) {
  const entry = conflicts.find((candidate) => candidate.path === conflictPath);
  if (!entry || entry.kind !== "choice") throw new Error("Conflict entry is not a choice");
  if (side === "project" && !entry.choices?.project) throw new Error("Project side deleted the file; only the workspace side exists");
  const source = side === "workspace" ? path.join(workspace, entry.path) : path.join(projectRoot, entry.path);
  const bytes = await fs.readFile(source);
  const target = path.join(workspace, TICKET_MERGE_DIR, "staged", entry.path);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);
  const next = conflicts.filter((candidate) => candidate.path !== conflictPath);
  const conflictsJson = `${JSON.stringify({ version: 1, conflicts: next }, null, 2)}
`;
  await fs.writeFile(path.join(workspace, TICKET_MERGE_DIR, "conflicts.json"), conflictsJson);
  return { conflicts: next, digest: sha256(Buffer.from(conflictsJson, "utf8")) };
}
async function baselineTreeProblems(workspace) {
  const baseline = await readBaseline(workspace);
  if (!baseline) return ["baseline manifest disappeared"];
  const problems = [];
  const baselineRoot = path.join(workspace, TICKET_BASELINE_DIR);
  const listed = /* @__PURE__ */ new Set(["manifest.json", ...Object.keys(baseline.manifest.files)]);
  const entries = await fs.readdir(baselineRoot, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const relative = path.relative(baselineRoot, path.join(entry.parentPath, entry.name)).split(path.sep).join("/");
    if (!listed.has(relative)) problems.push(`baseline gained an unlisted file: ${relative}`);
  }
  for (const [filePath, entry] of Object.entries(baseline.manifest.files)) {
    if ("symlink" in entry) continue;
    const current = await sha256File(path.join(baselineRoot, filePath));
    if (current !== entry.sha256) problems.push(`baseline content changed: ${filePath}`);
  }
  return problems;
}
async function sha256File(filePath) {
  try {
    return sha256(await fs.readFile(filePath));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function newMergeTransactionId() {
  return randomUUID();
}
export {
  TEXT_MERGE_LIMIT,
  assertPathContained,
  baselineTreeProblems,
  markerSyntaxLines,
  newMergeTransactionId,
  prepareTicketMerge,
  readBaseline,
  resolveChoiceConflict,
  scanTree,
  stagedPathFor,
  validateStagedConflicts
};
