import type { ChatMessage } from "./types.js";

export function buildHandoffContext(transcript: ChatMessage[]): string {
  const lines = transcript.slice(-30).map((message) => `${message.role}: ${message.text}`);
  const joined = lines.join("\n\n").slice(-8000);
  return [
    "Context handoff: you are continuing a conversation that was previously handled by another coding agent in this same project.",
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
