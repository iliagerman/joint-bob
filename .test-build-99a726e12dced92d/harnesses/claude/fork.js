import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { claudeSessionFilePath } from "../../claude-service.js";
import { conversationDraftPath } from "../../conversation-records.js";
import { HarnessForkError } from "../fork.js";
import { jsonl, resumableHistory, transcript } from "../fork-history.js";
function claudeBranch(entries) {
  const byId = new Map(entries.flatMap((entry, index2) => entry.uuid ? [[entry.uuid, index2]] : []));
  const selected = /* @__PURE__ */ new Set();
  let index = entries.length - 1;
  while (index >= 0) {
    if (selected.has(index)) throw new HarnessForkError(409, "Claude transcript has an invalid history branch");
    selected.add(index);
    const entry = entries[index];
    if (entry.subtype === "compact_boundary" || entry.parentUuid === null) break;
    if (entry.parentUuid !== void 0) {
      const parent = byId.get(entry.parentUuid);
      if (parent === void 0) throw new HarnessForkError(409, "Claude transcript has an invalid history branch");
      index = parent;
    } else index--;
  }
  return entries.filter((entry, entryIndex) => selected.has(entryIndex) || !entry.uuid && !entry.message && entry.type !== "system");
}
function claudeSidecars(source, destination, sessionId, cwd, files) {
  if (!existsSync(source)) return;
  if (!lstatSync(source).isDirectory() || lstatSync(source).isSymbolicLink()) throw new HarnessForkError(409, "Conversation sidecar must be a directory");
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) claudeSidecars(from, to, sessionId, cwd, files);
    else if (entry.isFile()) files.push({ destination: to, contents: entry.name.endsWith(".jsonl") ? jsonl(resumableHistory(claudeBranch(transcript(from))).map((record) => ({ ...record, sessionId, ...record.message && record.message.role === "assistant" ? { jointBobUsageOrigin: record.jointBobUsageOrigin ?? sessionId } : {}, ...record.cwd ? { cwd } : {} }))) : readFileSync(from) });
    else throw new HarnessForkError(409, "Conversation sidecars cannot contain links");
  }
}
function snapshotClaudeFork(options) {
  if (options.draft && !options.live) return { sessionPath: conversationDraftPath("claude", options.newSessionId), files: [] };
  const sourcePath = options.sessionPath.replace(/^claude:/, "");
  const destination = claudeSessionFilePath(options.project.path, options.newSessionId);
  const entries = resumableHistory(claudeBranch(transcript(sourcePath))).map((record) => ({ ...record, sessionId: options.newSessionId, cwd: options.project.path, ...record.message && record.message.role === "assistant" ? { jointBobUsageOrigin: record.jointBobUsageOrigin ?? options.sessionId } : {}, ...record.isSidechain ? { isSidechain: false } : {} }));
  entries.push({ type: "custom-title", customTitle: options.title, sessionId: options.newSessionId, cwd: options.project.path, timestamp: options.timestamp });
  const files = [{ destination, contents: jsonl(entries) }];
  claudeSidecars(path.join(path.dirname(sourcePath), options.sessionId), path.join(path.dirname(destination), options.newSessionId), options.newSessionId, options.project.path, files);
  return { sessionPath: `claude:${destination}`, files };
}
export {
  snapshotClaudeFork
};
