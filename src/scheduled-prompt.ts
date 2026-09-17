// A scheduled run's trigger prompt is the scheduler talking, not the person, so
// it carries a marker the saved transcript keeps. The browser view collapses
// those turns to their final report; everything a person typed stays visible.
export const SCHEDULED_PROMPT_MARKER = "[Joint Bob scheduled task]";

export function scheduledPromptText(prompt: string): string {
  return `${SCHEDULED_PROMPT_MARKER}\n${prompt}`;
}

/** Drops the marker so a scheduled prompt still reads naturally in titles and summaries. */
export function stripScheduledPromptMarker(text: string): string {
  const trimmed = text.trimStart();
  return trimmed.startsWith(`${SCHEDULED_PROMPT_MARKER}\n`) ? trimmed.slice(SCHEDULED_PROMPT_MARKER.length + 1) : text;
}

export function isScheduledPromptText(text: string): boolean {
  return text.trimStart().startsWith(`${SCHEDULED_PROMPT_MARKER}\n`);
}

