export function harnessIdFromPath(harnesses, sessionPath) {
  const path = String(sessionPath || "");
  const draft = /^draft:([^:]+):/.exec(path);
  if (draft) {
    const harness = harnesses.find(({ id }) => id === draft[1]);
    if (harness) return harness.id;
  }
  const exact = harnesses.find(({ newSessionPath }) => newSessionPath === path);
  if (exact) return exact.id;
  const prefixed = /^([^:]+):/.exec(path);
  if (prefixed) {
    const harness = harnesses.find(({ id }) => id === prefixed[1]);
    if (harness) return harness.id;
  }
  const legacy = harnesses.find(({ newSessionPath }) => newSessionPath === "new");
  if (legacy && !path.includes(":")) return legacy.id;
  throw new Error(`Cannot resolve harness for session path: ${path}`);
}

export function harnessLabel(harnesses, id) {
  return harnesses.find((harness) => harness.id === id)?.label || id;
}

/** A listed logical conversation can be addressed through any harness segment it contains. */
export function sessionHasHarnessIdentity(session, engine, sessionId) {
  if (!engine || !sessionId) return false;
  if ((session.harnessId || session.engine) === engine && (session.id || session.sessionId) === sessionId) return true;
  return session.segments?.some((segment) => segment.engine === engine && segment.sessionId === sessionId) || false;
}
