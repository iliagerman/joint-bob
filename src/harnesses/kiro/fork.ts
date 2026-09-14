import path from "node:path";
import { conversationDraftPath } from "../../conversation-records.js";
import type { HarnessForkOptions, HarnessForkSnapshot } from "../fork.js";
import { HarnessForkError } from "../fork.js";
import { jsonl, transcript, type ForkEntry } from "../fork-history.js";
import { kiroSessionFilePath } from "./storage.js";

function requiredString(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }

export function snapshotKiroFork(options: HarnessForkOptions): HarnessForkSnapshot {
  if (options.draft) return { sessionPath: conversationDraftPath("kiro", options.newSessionId), files: [] };
  const sourcePath = path.resolve(options.sessionPath.replace(/^kiro:/, ""));
  if (sourcePath !== path.resolve(kiroSessionFilePath(options.sessionId))) throw new HarnessForkError(409, "Kiro transcript is outside its alias root");
  const records = transcript(sourcePath);
  const source = records[0];
  if (source.type !== "joint-bob-kiro" || source.version !== 1 || source.id !== options.sessionId) throw new HarnessForkError(409, "Invalid Kiro transcript header");
  let modelId = source.modelId, reasoning = source.reasoning, enabledTools = source.enabledTools;
  const messages: ForkEntry[] = [];
  for (const record of records.slice(1)) {
    if (record.type === "settings") { modelId = record.modelId; reasoning = record.reasoning; enabledTools = record.enabledTools; }
    else if (record.type === "message") {
      if ((record.role !== "user" && record.role !== "assistant") || typeof record.text !== "string") throw new HarnessForkError(409, "Invalid Kiro message record");
      messages.push(record);
    } else if (!["native-session", "title", "handoff-completed"].includes(String(record.type))) throw new HarnessForkError(409, `Invalid Kiro transcript record type: ${String(record.type)}`);
  }
  if (!requiredString(modelId) || !requiredString(reasoning)) throw new HarnessForkError(409, "Invalid Kiro transcript header");
  if (enabledTools !== undefined && (!Array.isArray(enabledTools) || enabledTools.some((name) => typeof name !== "string" || !name))) throw new HarnessForkError(409, "Invalid Kiro enabled tools");
  const header: ForkEntry = { type: "joint-bob-kiro", version: 1, id: options.newSessionId, cwd: options.project.path, nativeSessionId: null, modelId, reasoning, ...(enabledTools === undefined ? {} : { enabledTools }), timestamp: options.timestamp, handoffPending: true };
  const title = { type: "title", title: options.title, timestamp: options.timestamp };
  const destination = kiroSessionFilePath(options.newSessionId);
  return { sessionPath: `kiro:${destination}`, files: [{ destination, contents: jsonl([header, ...messages, title]) }] };
}
