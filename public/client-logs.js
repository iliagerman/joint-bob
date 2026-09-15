// Capture diagnostics before application modules load. Session storage survives a
// reload but remains local to this browser tab; bounded entries avoid causing the
// memory pressure this log exists to diagnose.
(() => {
  const key = "joint-bob-client-logs-v1";
  const limit = 250;
  const argumentLimit = 4000;
  let entries = [];
  try {
    const stored = JSON.parse(sessionStorage.getItem(key) || "[]");
    if (Array.isArray(stored)) entries = stored.filter((entry) => typeof entry === "string").slice(-limit);
  } catch {
    entries = [];
  }
  const format = (value) => {
    if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
    if (typeof value === "string") return value;
    if (value === undefined) return "undefined";
    try { return JSON.stringify(value); } catch { return String(value); }
  };
  const record = (level, values) => {
    const message = values.map(format).join(" ").slice(0, argumentLimit);
    entries.push(`[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`);
    entries = entries.slice(-limit);
    try { sessionStorage.setItem(key, JSON.stringify(entries)); } catch { /* storage unavailable */ }
    window.dispatchEvent(new Event("joint-bob-client-logs-changed"));
  };
  for (const level of ["debug", "info", "log", "warn", "error"]) {
    const native = console[level].bind(console);
    console[level] = (...values) => { record(level, values); native(...values); };
  }
  window.addEventListener("error", (event) => record("uncaught", [event.error || `${event.message} at ${event.filename}:${event.lineno}:${event.colno}`]));
  window.addEventListener("unhandledrejection", (event) => record("unhandled", [event.reason]));
  window.jointBobClientLogs = {
    entries: () => [...entries],
    clear: () => { entries = []; try { sessionStorage.removeItem(key); } catch { /* storage unavailable */ } window.dispatchEvent(new Event("joint-bob-client-logs-changed")); },
  };
  const navigation = performance.getEntriesByType("navigation")[0]?.type || "navigate";
  record("page", [`loaded navigation=${navigation} visibility=${document.visibilityState}`]);
})();
