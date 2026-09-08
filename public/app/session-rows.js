import { ticketGlyph } from "../board.js";
import { api, savePreferencesInBackground } from "./api.js";
import { renderProjects } from "./project-list.js";
import { renderSessions } from "./session-list.js";
import { toast } from "./shell.js";
import { state } from "./state.js";
import { openEditTaskDialog } from "./tasks.js";

/** The fixed palette mirrors PROJECT_COLORS in src/types.ts. */
export const PROJECT_COLORS = ["slate", "teal", "blue", "violet", "magenta", "amber", "green", "red"];

export function isProjectPinned(projectId) {
  return state.pinnedProjectIds.includes(projectId) || state.replicatedPinnedProjectIds.includes(projectId);
}

function sessionPinEngine(session) {
  // The logical identity uses the FIRST segment's engine, which never changes,
  // so a pin survives later harness switches.
  return session.segments?.[0]?.engine || session.engine || session.harnessId || ((session.sessionPath || session.path || "").startsWith("claude:") ? "claude" : "pi");
}

function sessionPinIdentities(session) {
  const projectId = session.projectId || state.activeProjectId;
  const sessionId = session.sessionId || session.id;
  if (!projectId || !sessionId) return [];
  const identities = [{ engine: sessionPinEngine(session), sessionId: session.conversationId || sessionId }];
  for (const segment of session.segments || []) identities.push({ engine: segment.engine, sessionId: segment.sessionId });
  return identities.map((identity) => ({ projectId, ...identity }));
}

function sessionPinIdentity(session) {
  return sessionPinIdentities(session)[0] ?? null;
}

export function isSessionPinned(session) {
  if (typeof session === "object") {
    if ((session.segments || []).some((segment) => state.pinnedSessionPaths.includes(segment.path))) return true;
    const identities = sessionPinIdentities(session);
    if (identities.some((identity) => state.pinnedConversations.some((pin) => pin.projectId === identity.projectId && pin.engine === identity.engine && pin.sessionId === identity.sessionId))) return true;
  }
  const sessionPath = typeof session === "string" ? session : session.sessionPath || session.path;
  return state.pinnedSessionPaths.includes(sessionPath);
}

/** Stable within each side of the split, so pinning never reshuffles the rest of the list. */
export function sortPinnedFirst(items, isPinned) {
  return [...items.filter(isPinned), ...items.filter((item) => !isPinned(item))];
}

export function sessionTranscriptName(sessionPath) {
  return sessionPath.replace(/\\/g, "/").split("/").at(-1);
}

/** A conversation listed with a taskId belongs to a board ticket; resolve it for the mark and the jump. */
export function sessionTicketTask(session) {
  return session.taskId ? state.tasks.find((task) => task.id === session.taskId) : undefined;
}

/** The mark itself: quiet, accent-coloured, and titled with the ticket it belongs to. */
export function ticketBadge(task) {
  const badge = document.createElement("em");
  badge.className = "session-ticket-badge";
  badge.setAttribute("data-testid", "session-ticket-badge");
  badge.title = `Belongs to ticket: ${task.title}`;
  badge.append(ticketGlyph("session-ticket-icon"), document.createTextNode("Ticket"));
  return badge;
}

/** The quick jump: one tap from the conversations list into the ticket itself. */
export function ticketRowButton(task) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost icon-button row-action-button ticket-link-button";
  button.setAttribute("data-testid", "session-ticket-button");
  button.setAttribute("aria-label", `Open ticket ${task.title}`);
  button.title = `Open ticket: ${task.title}`;
  button.append(ticketGlyph("session-ticket-icon"));
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    openEditTaskDialog(task);
  });
  return button;
}

export function nestedSessionRows(sessions, shouldExpand = () => true) {
  const ranked = sortPinnedFirst(sessions, isSessionPinned);
  const byPath = new Map(ranked.map((session) => [session.path, session]));
  const byName = new Map(ranked.map((session) => [sessionTranscriptName(session.path), session]));
  const parentOf = (session) => {
    if (!session.parentSessionPath) return null;
    const parent = byPath.get(session.parentSessionPath) || byName.get(sessionTranscriptName(session.parentSessionPath));
    return parent?.path === session.path ? null : parent;
  };
  const children = new Map();
  for (const session of ranked) {
    const parent = parentOf(session);
    if (parent) children.set(parent.path, [...(children.get(parent.path) || []), session]);
  }
  const roots = [];
  for (const session of ranked) {
    let root = session;
    const ancestry = new Set([session.path]);
    let parent = parentOf(root);
    while (parent && !ancestry.has(parent.path)) {
      root = parent;
      ancestry.add(root.path);
      parent = parentOf(root);
    }
    if (!roots.includes(root)) roots.push(root);
  }
  const rows = [];
  const append = (session, depth) => {
    if (rows.some((row) => row.session === session)) return;
    const childSessions = children.get(session.path) || [];
    rows.push({ session, depth, childCount: childSessions.length });
    if (!shouldExpand(session, childSessions)) return;
    for (const child of childSessions) append(child, depth + 1);
  };
  for (const root of roots) append(root, 0);
  return rows;
}

export function togglePinnedProject(projectId) {
  const pinned = !isProjectPinned(projectId);
  state.pinnedProjectIds = state.pinnedProjectIds.filter((id) => id !== projectId);
  state.replicatedPinnedProjectIds = pinned
    ? [...state.replicatedPinnedProjectIds.filter((id) => id !== projectId), projectId]
    : state.replicatedPinnedProjectIds.filter((id) => id !== projectId);
  if (state.preferencesLoaded) {
    savePreferencesInBackground({ pinnedProjectIds: state.pinnedProjectIds });
    void api("/api/pins", { method: "PUT", body: JSON.stringify({ kind: "project", projectId, pinned }) }).catch((error) => toast(error.message));
  }
  renderProjects();
}

export function togglePinnedSession(session) {
  const identity = sessionPinIdentity(session);
  if (!identity) throw new Error("Conversation pin needs a stable identity");
  const pinned = !isSessionPinned(session);
  // Pins made before a switch name older segments; unpinning clears them all so
  // the row cannot resurrect from a stale segment pin.
  const legacy = sessionPinIdentities(session).filter((candidate) => candidate.engine !== identity.engine || candidate.sessionId !== identity.sessionId);
  const segmentPaths = [session.sessionPath || session.path, ...(session.segments || []).map((segment) => segment.path)];
  state.pinnedSessionPaths = state.pinnedSessionPaths.filter((path) => !segmentPaths.includes(path));
  state.pinnedConversations = state.pinnedConversations.filter((pin) => !(pin.projectId === identity.projectId
    && (pin.engine === identity.engine && pin.sessionId === identity.sessionId
      || legacy.some((candidate) => candidate.engine === pin.engine && candidate.sessionId === pin.sessionId))));
  if (pinned) state.pinnedConversations.push(identity);
  if (state.preferencesLoaded) {
    savePreferencesInBackground({ pinnedSessionPaths: state.pinnedSessionPaths });
    for (const target of pinned ? [identity] : [identity, ...legacy]) {
      void api("/api/pins", { method: "PUT", body: JSON.stringify({ kind: "conversation", ...target, pinned }) }).catch((error) => toast(error.message));
    }
  }
  renderSessions();
}
