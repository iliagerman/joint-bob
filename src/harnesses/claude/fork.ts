import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { claudeSessionFilePath } from "../../claude-service.js";
import { conversationDraftPath } from "../../conversation-records.js";
import type { HarnessForkFile, HarnessForkOptions, HarnessForkSnapshot } from "../fork.js";
import { HarnessForkError } from "../fork.js";
import { jsonl, resumableHistory, transcript, type ForkEntry } from "../fork-history.js";

function claudeBranch(entries: ForkEntry[]): ForkEntry[] {
  const byId = new Map(entries.flatMap((entry, index) => entry.uuid ? [[entry.uuid, index] as const] : []));
  const selected = new Set<number>();
  let index = entries.length - 1;
  while (index >= 0) {
    if (selected.has(index)) throw new HarnessForkError(409, "Claude transcript has an invalid history branch");
    selected.add(index);
    const entry = entries[index];
    if (entry.subtype === "compact_boundary" || entry.parentUuid === null) break;
    if (entry.parentUuid !== undefined) {
      const parent = byId.get(entry.parentUuid);
      if (parent === undefined) throw new HarnessForkError(409, "Claude transcript has an invalid history branch");
      index = parent;
    } else index--;
  }
  return entries.filter((entry, entryIndex) => selected.has(entryIndex) || (!entry.uuid && !entry.message && entry.type !== "system"));
}

function claudeSidecars(source: string, destination: string, sessionId: string, cwd: string, files: HarnessForkFile[]): void {
  if (!existsSync(source)) return;
  if (!lstatSync(source).isDirectory() || lstatSync(source).isSymbolicLink()) throw new HarnessForkError(409, "Conversation sidecar must be a directory");
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) claudeSidecars(from, to, sessionId, cwd, files);
    else if (entry.isFile()) files.push({ destination: to, contents: entry.name.endsWith(".jsonl") ? jsonl(resumableHistory(claudeBranch(transcript(from))).map((record) => ({ ...record, sessionId, ...(record.cwd ? { cwd } : {}) }))) : readFileSync(from) });
    else throw new HarnessForkError(409, "Conversation sidecars cannot contain links");
  }
}

export function snapshotClaudeFork(options: HarnessForkOptions): HarnessForkSnapshot {
  if (options.draft && !options.live) return { sessionPath: conversationDraftPath("claude", options.newSessionId), files: [] };
  const sourcePath = options.sessionPath.replace(/^claude:/, "");
  const destination = claudeSessionFilePath(options.project.path, options.newSessionId);
  const entries: ForkEntry[] = resumableHistory(claudeBranch(transcript(sourcePath))).map((record) => ({ ...record, sessionId: options.newSessionId, cwd: options.project.path, ...(record.isSidechain ? { isSidechain: false } : {}) }));
  entries.push({ type: "custom-title", customTitle: options.title, sessionId: options.newSessionId, cwd: options.project.path, timestamp: options.timestamp });
  const files: HarnessForkFile[] = [{ destination, contents: jsonl(entries) }];
  claudeSidecars(path.join(path.dirname(sourcePath), options.sessionId), path.join(path.dirname(destination), options.newSessionId), options.newSessionId, options.project.path, files);
  return { sessionPath: `claude:${destination}`, files };
}
