import { randomUUID } from "node:crypto";
import { migrateSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";
import { conversationDraftPath } from "../../conversation-records.js";
import { getSettings } from "../../settings.js";
import { HarnessForkError } from "../fork.js";
import { jsonl, resumableHistory, transcript } from "../fork-history.js";
import { piForkEntries } from "./runtime.js";
function piBranch(entries) {
  migrateSessionEntries(entries);
  const byId = new Map(entries.slice(1).map((entry2) => [entry2.id, entry2]));
  const branch = [];
  let entry = entries.at(-1);
  while (entry && entry.type !== "session") {
    branch.push(entry);
    byId.delete(entry.id);
    if (!entry.parentId) break;
    entry = byId.get(entry.parentId);
    if (!entry) throw new HarnessForkError(409, "Pi transcript has an invalid history branch");
  }
  return [entries[0], ...branch.reverse()];
}
function snapshotPiFork(options) {
  if (options.draft && !options.live) return { sessionPath: conversationDraftPath("pi", options.newSessionId), files: [] };
  const entries = resumableHistory(options.live ? piForkEntries(options.live) : piBranch(transcript(options.sessionPath))).map((entry) => {
    const message = entry.message;
    return message?.role === "assistant" ? { ...entry, jointBobUsageOrigin: entry.jointBobUsageOrigin ?? options.sessionId } : entry;
  });
  if (entries[0]?.type !== "session") throw new HarnessForkError(409, "Pi transcript has no session header");
  entries[0] = { ...entries[0], id: options.newSessionId, cwd: options.project.path, timestamp: options.timestamp };
  delete entries[0].parentSession;
  entries.push({ type: "session_info", id: randomUUID(), parentId: entries.length > 1 ? entries.at(-1).id : null, timestamp: options.timestamp, name: options.title });
  const sessionPath = SessionManager.create(options.project.path, getSettings().pi.sessionPath || void 0, { id: options.newSessionId }).getSessionFile();
  return { sessionPath, files: [{ destination: sessionPath, contents: jsonl(entries) }] };
}
export {
  snapshotPiFork
};
