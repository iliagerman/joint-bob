import { lstatSync, readFileSync } from "node:fs";
import { parseCompletedJsonl } from "../jsonl.js";
import { HarnessForkError } from "./fork.js";

export type ForkEntry = Record<string, unknown>;

export function transcript(file: string): ForkEntry[] {
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new HarnessForkError(409, "Conversation transcript must be a regular file");
  const contents = readFileSync(file).subarray(0, before.size).toString("utf8");
  try {
    const entries = parseCompletedJsonl(contents);
    if (!entries.length || entries.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) throw new Error("Invalid transcript");
    return entries as ForkEntry[];
  } catch { throw new HarnessForkError(409, "Conversation transcript is incomplete or invalid"); }
}

export const jsonl = (entries: ForkEntry[]) => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";

export function resumableHistory(entries: ForkEntry[]): ForkEntry[] {
  const history = entries.filter((entry) => entry.type !== "queue-operation");
  const pending = new Set<unknown>();
  let complete = 0;
  for (const [index, entry] of history.entries()) {
    const message = entry.message as ForkEntry | undefined;
    const blocks = Array.isArray(message?.content) ? message.content as ForkEntry[] : [];
    for (const block of blocks) if (block.type === "toolCall" || block.type === "tool_use") pending.add(block.id);
    const results = blocks.filter((block) => block.type === "tool_result").map((block) => block.tool_use_id);
    if (message?.role === "toolResult") results.push(message.toolCallId);
    if (results.some((id) => !pending.delete(id))) break;
    if (!pending.size) complete = index + 1;
  }
  return history.slice(0, complete);
}
