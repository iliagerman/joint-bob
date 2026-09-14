import { randomUUID } from "node:crypto";
import { migrateSessionEntries, SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import { conversationDraftPath } from "../../conversation-records.js";
import { getSettings } from "../../settings.js";
import type { HarnessForkOptions, HarnessForkSnapshot } from "../fork.js";
import { HarnessForkError } from "../fork.js";
import { jsonl, resumableHistory, transcript, type ForkEntry } from "../fork-history.js";
import { piForkEntries } from "./runtime.js";

function piBranch(entries: ForkEntry[]): ForkEntry[] {
  migrateSessionEntries(entries as unknown as FileEntry[]);
  const byId = new Map(entries.slice(1).map((entry) => [entry.id, entry]));
  const branch: ForkEntry[] = [];
  let entry = entries.at(-1);
  while (entry && entry.type !== "session") {
    branch.push(entry); byId.delete(entry.id);
    if (!entry.parentId) break;
    entry = byId.get(entry.parentId);
    if (!entry) throw new HarnessForkError(409, "Pi transcript has an invalid history branch");
  }
  return [entries[0], ...branch.reverse()];
}

export function snapshotPiFork(options: HarnessForkOptions): HarnessForkSnapshot {
  if (options.draft && !options.live) return { sessionPath: conversationDraftPath("pi", options.newSessionId), files: [] };
  const entries = resumableHistory(options.live ? piForkEntries(options.live) as ForkEntry[] : piBranch(transcript(options.sessionPath)));
  if (entries[0]?.type !== "session") throw new HarnessForkError(409, "Pi transcript has no session header");
  entries[0] = { ...entries[0], id: options.newSessionId, cwd: options.project.path, timestamp: options.timestamp };
  delete entries[0].parentSession;
  entries.push({ type: "session_info", id: randomUUID(), parentId: entries.length > 1 ? entries.at(-1)!.id : null, timestamp: options.timestamp, name: options.title });
  const sessionPath = SessionManager.create(options.project.path, getSettings().pi.sessionPath || undefined, { id: options.newSessionId }).getSessionFile()!;
  return { sessionPath, files: [{ destination: sessionPath, contents: jsonl(entries) }] };
}
