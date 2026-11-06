/**
 * What a running turn is doing now, read from its live events, for the board card: the tool it is running or ran last, with
 * what it runs on, the last line it wrote, or that it is thinking. Null before the turn has done anything.
 */

const ACTIVITY_CHARACTERS = 140;

type LiveEvent = Record<string, unknown>;

function shortened(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > ACTIVITY_CHARACTERS ? `${line.slice(0, ACTIVITY_CHARACTERS - 1)}…` : line;
}

function toolStep(event: LiveEvent): string {
  const name = typeof event.toolName === "string" && event.toolName ? event.toolName : "a tool";
  const target = event.toolTarget as { target?: unknown; skill?: unknown } | undefined;
  const on = typeof target?.skill === "string" ? `skill ${target.skill}` : typeof target?.target === "string" ? target.target : "";
  return shortened(on ? `${name} · ${on}` : `Running ${name}`);
}

/** The last line of what the agent wrote, so a long paragraph shows where it got to. */
function lastLine(text: string): string {
  const lines = text.split("\n").map((line) => line.replace(/[*_`#>]/g, "").trim()).filter(Boolean);
  return shortened(lines.at(-1) ?? "");
}

export function currentActivity(events: ReadonlyArray<LiveEvent>): string | null {
  for (const event of [...events].reverse()) {
    if (event.type === "toolStart") return toolStep(event);
    if (event.type === "textDelta" && typeof event.text === "string" && event.text.trim()) return lastLine(event.text);
    if (event.type === "thinkingDelta") return "Thinking…";
  }
  return null;
}
