const SCHEDULED_PROMPT_MARKER = "[Joint Bob scheduled task]";
function scheduledPromptText(prompt) {
  return `${SCHEDULED_PROMPT_MARKER}
${prompt}`;
}
function stripScheduledPromptMarker(text) {
  const trimmed = text.trimStart();
  return trimmed.startsWith(`${SCHEDULED_PROMPT_MARKER}
`) ? trimmed.slice(SCHEDULED_PROMPT_MARKER.length + 1) : text;
}
function isScheduledPromptText(text) {
  return text.trimStart().startsWith(`${SCHEDULED_PROMPT_MARKER}
`);
}
export {
  SCHEDULED_PROMPT_MARKER,
  isScheduledPromptText,
  scheduledPromptText,
  stripScheduledPromptMarker
};
