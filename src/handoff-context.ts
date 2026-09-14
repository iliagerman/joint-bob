import type { ChatMessage } from "./types.js";

const HANDOFF_MESSAGE_LIMIT = 30;
const HANDOFF_CHARACTER_LIMIT = 8000;

export function buildHandoffContext(transcript: ChatMessage[], sourcePath?: string): string {
  const recent = transcript.slice(-HANDOFF_MESSAGE_LIMIT);
  const fullText = recent.map((message) => `${message.role}: ${message.text}`).join("\n\n");
  const joined = fullText.slice(-HANDOFF_CHARACTER_LIMIT);
  const notice: string[] = [];
  if (recent.length < transcript.length) notice.push(`This conversation was truncated to the last ${recent.length} of ${transcript.length} messages.`);
  if (joined.length < fullText.length) notice.push(`The included messages were also truncated to the last ${HANDOFF_CHARACTER_LIMIT.toLocaleString("en-US")} characters.`);
  if (notice.length && sourcePath) notice.push(`Earlier messages are available at ${sourcePath.replace(/^[^:]+:(?=\/)/, "")}. Read that transcript if more context is needed.`);
  return [
    "Context handoff: you are continuing a conversation that was previously handled by another coding agent in this same project.",
    ...notice,
    "Recent transcript between the user and the previous agent:",
    "",
    joined,
    "",
    "Continue the work seamlessly. The user's next message follows.",
    "---",
    "",
  ].join("\n");
}

const HANDOFF_ENVELOPE_PREFIX = "Context handoff:";

export function stripHandoffEnvelope(text: string): string {
  const start = text.startsWith(HANDOFF_ENVELOPE_PREFIX) ? 0 : text.indexOf(`\n${HANDOFF_ENVELOPE_PREFIX}`);
  if (start === -1) return text;
  const separator = text.indexOf("\n---\n", start);
  return separator === -1 ? text : text.slice(separator + "\n---\n".length);
}
