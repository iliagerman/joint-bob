import { state } from "./state.js";

/**
 * A conversation action shows on its row the moment it is clicked, before the server has
 * answered. Each change is laid over every list the server sends until a list asked for after
 * the server confirmed it arrives, so a refresh already in flight cannot flip the row back.
 * A refusal takes the change off and puts the row back as it was.
 */
const changes = [];

/** A removed conversation can linger in lists for a while: one owned by another machine is
    deleted there, and this machine's copy goes only when that reaches it. */
const REMOVAL_LINGER_MS = 30_000;

const conversationKey = (session) => session.conversationId || session.id;

function applyChanges(sessions, projectId) {
  const relevant = changes.filter((change) => change.projectId === projectId);
  if (!relevant.length) return sessions;
  const removed = new Set(relevant.filter((change) => change.remove).map((change) => change.key));
  const kept = removed.size ? sessions.filter((session) => !removed.has(conversationKey(session))) : sessions;
  for (const change of relevant) {
    if (change.remove) continue;
    for (const session of kept) if (conversationKey(session) === change.key) Object.assign(session, change.patch);
  }
  return kept;
}

/**
 * The server's conversations for one project with every unconfirmed change on top. `askedAt`
 * is performance.now() when the list was requested: a change the server had confirmed by
 * then is already in the list, so it is dropped here.
 */
export function withPendingSessionChanges(projectId, sessions, askedAt) {
  const present = new Set(sessions.map(conversationKey));
  for (let index = changes.length - 1; index >= 0; index -= 1) {
    const change = changes[index];
    if (change.confirmedAt === undefined || change.confirmedAt > askedAt) continue;
    if (change.remove && present.has(change.key) && askedAt - change.confirmedAt < REMOVAL_LINGER_MS) continue;
    changes.splice(index, 1);
  }
  return applyChanges(sessions, projectId);
}

/**
 * Shows `patch` (or the row's removal) at once, then runs `request`. Resolves with its result;
 * on a failure the row is restored, `render` redraws it, and the error is rethrown for the
 * caller to report.
 */
export async function changeSessionOptimistically(session, { patch = {}, remove = false }, request, render) {
  const projectId = state.activeProjectId;
  const key = conversationKey(session);
  const index = state.sessions.findIndex((candidate) => conversationKey(candidate) === key);
  const current = state.sessions[index] ?? session;
  const before = Object.fromEntries(Object.keys(patch).map((field) => [field, current[field]]));
  const change = { projectId, key, patch, remove, confirmedAt: undefined };
  changes.push(change);
  state.sessions = applyChanges(state.sessions, projectId);
  render();
  try {
    const result = await request();
    change.confirmedAt = performance.now();
    return result;
  } catch (error) {
    changes.splice(changes.indexOf(change), 1);
    if (state.activeProjectId === projectId) {
      if (remove && !state.sessions.some((candidate) => conversationKey(candidate) === key)) {
        state.sessions.splice(index < 0 ? 0 : Math.min(index, state.sessions.length), 0, current);
      }
      for (const candidate of state.sessions) if (conversationKey(candidate) === key) Object.assign(candidate, before);
      // A later change to the same conversation still stands.
      state.sessions = applyChanges(state.sessions, projectId);
      render();
    }
    throw error;
  }
}
