export function formatDuration(ms) {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 10) return `${seconds > 0 && seconds < 0.05 ? 0.1 : seconds.toFixed(1)}s`;
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m ${String(whole % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatDateTime(date) {
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function recordedAt(message) {
  const value = Date.parse(String(message.timestamp ?? ""));
  return Number.isFinite(value) ? value : null;
}

export function completedConversationDuration(messages, activeTurnStartedAt = 0) {
  let total = 0;
  let turnStartedAt = null;
  let turnFinishedAt = null;
  for (const message of messages || []) {
    const timestamp = recordedAt(message);
    if (timestamp === null) continue;
    if (message.role === "user") {
      if (turnStartedAt !== null && turnFinishedAt > turnStartedAt) total += turnFinishedAt - turnStartedAt;
      turnStartedAt = timestamp;
      turnFinishedAt = timestamp;
    } else if (turnStartedAt !== null) {
      turnFinishedAt = Math.max(turnFinishedAt, timestamp);
    }
  }
  const lastTurnIsRunning = activeTurnStartedAt && turnStartedAt !== null && turnStartedAt >= activeTurnStartedAt;
  if (!lastTurnIsRunning && turnStartedAt !== null && turnFinishedAt > turnStartedAt) total += turnFinishedAt - turnStartedAt;
  return total;
}
