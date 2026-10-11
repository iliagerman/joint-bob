// Sends UI errors to this node, which forwards them to ntfy when Settings →
// Notifications turns client errors on. The node also throttles; this keeps a
// looping error from sending a request per frame.
import { state } from "./state.js";

const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 10;
const recent = new Map();
let windowStartedAt = 0;
let sentInWindow = 0;

function admit(message, now) {
  if (now - windowStartedAt >= WINDOW_MS) { windowStartedAt = now; sentInWindow = 0; }
  for (const [key, at] of recent) if (now - at >= WINDOW_MS) recent.delete(key);
  const key = message.split("\n")[0].slice(0, 300);
  if (recent.has(key) || sentInWindow >= MAX_PER_WINDOW) return false;
  recent.set(key, now);
  sentInWindow += 1;
  return true;
}

window.addEventListener("joint-bob-client-error", (event) => {
  const { kind, message } = event.detail || {};
  if (!state.authenticated || !state.csrfToken || !message || !admit(message, Date.now())) return;
  // Plain fetch: api() signs the page out on 401, and a failed report must not report itself.
  fetch("/api/client-errors", {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": state.csrfToken },
    body: JSON.stringify({ kind, message: message.slice(0, 4000), page: `${location.pathname}${location.hash}`.slice(0, 500) }),
  }).catch(() => undefined);
});
