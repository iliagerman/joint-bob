import { COMPACTION_INACTIVITY_TIMEOUT_MS, CONVERSATION_INACTIVITY_TIMEOUT_MS, conversationInactive } from "../conversation-watchdog.js";
import { conversationWorkActive } from "../conversation-work.js";
import { getHarness, getHarnessRuntime, refreshHarnessSessions } from "../harnesses.js";
import { broadcastToProject, scheduleReviewNotifications, send } from "./realtime.js";
import { idleSessionTimeoutMs, localWriteGraceMs } from "./state.js";
const harnessSessions = /* @__PURE__ */ new Map();
const pendingOpen = /* @__PURE__ */ new Map();
function harnessSessionKey(projectId, engine, sessionId) {
  return JSON.stringify([projectId, engine, sessionId]);
}
function findHarnessSession(projectId, engine, id) {
  return harnessSessions.get(harnessSessionKey(projectId, engine, id));
}
function harnessTurnBusy(shared) {
  return shared.turnInFlight > 0 || shared.session.isBusy();
}
function harnessSessionBusy(shared) {
  return harnessTurnBusy(shared) || conversationWorkActive(shared.engine, shared.session.id);
}
function listHarnessSessionsRunning() {
  return [...harnessSessions.values()].filter(harnessSessionBusy);
}
function historyBeforeLiveTurn(messages, shared) {
  const startedAt = Date.parse(shared.turnStartedAt ?? "");
  if (!Number.isFinite(startedAt) || !shared.liveEvents.length) return messages;
  return messages.filter((message) => message.role === "user" || !(Date.parse(message.timestamp ?? "") >= startedAt));
}
function appendEvent(events, event) {
  const previous = events.at(-1);
  const delta = event.type === "textDelta" || event.type === "thinkingDelta";
  if (delta && previous && previous.type === event.type && typeof previous.text === "string" && typeof event.text === "string") {
    previous.text += event.text;
  } else events.push({ ...event });
}
function subscribe(shared) {
  let announcedFile;
  return shared.session.subscribe((event) => {
    const internal = shared.internalTurn === true;
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const timed = ["agent_start", "agent_end", "toolStart", "toolEnd"].includes(String(event.type)) ? { ...event, timestamp } : event;
    markHarnessActivity(shared);
    if (!internal && event.type === "agent_start") {
      shared.liveEvents = [];
      shared.turnStartedAt = timestamp;
    }
    if (!internal && shared.turnInFlight) appendEvent(shared.liveEvents, timed);
    if (!internal) for (const client of shared.clients) send(client, timed);
    const file = shared.session.file;
    if (event.type === "sessionFile" && typeof event.sessionFile === "string") announcedFile = event.sessionFile;
    if (file && file !== announcedFile && event.type !== "sessionFile") {
      announcedFile = file;
      if (!internal) for (const client of shared.clients) send(client, { type: "sessionFile", sessionId: shared.session.id, sessionFile: file });
    }
    if (event.type === "agent_start" || event.type === "status" || event.type === "conversationWorkChanged") broadcastToProject(shared.projectId, { type: "sessionsChanged" });
    if (!internal && event.type === "conversationWorkChanged") scheduleReviewNotifications(shared.projectId);
    if (event.type === "agent_end") {
      if (!internal) {
        shared.liveEvents = [];
        shared.turnStartedAt = void 0;
      }
      const refreshFile = file ? getHarness(shared.engine).paths.transcriptFile?.(file) ?? file : void 0;
      const refresh = refreshHarnessSessions(shared.projectId, refreshFile ? [refreshFile] : []);
      void refresh.then(() => {
        broadcastToProject(shared.projectId, { type: "sessionsChanged" });
        if (!internal) scheduleReviewNotifications(shared.projectId);
      }).catch((error) => console.error("Could not refresh completed harness session", error));
    }
    if (["agent_start", "agent_end", "status", "configuration", "sessionFile", "conversationWorkChanged"].includes(String(event.type))) sendHarnessStatus(shared);
  });
}
async function createSession(engine, options) {
  const session = await (await getHarnessRuntime(engine)).open(options);
  if (session.id !== options.sessionId) throw new Error(`Harness returned unexpected session ID: ${session.id}`);
  const shared = { engine, projectId: options.projectId, conversationId: options.conversationId ?? options.sessionId, cwd: options.cwd, session, clients: /* @__PURE__ */ new Set(), turnInFlight: 0, lastLocalEventAt: 0, lastActivityAt: 0, liveEvents: [], idleTimer: null, unsubscribe: () => {
  }, scheduledTurn: false };
  shared.unsubscribe = subscribe(shared);
  harnessSessions.set(harnessSessionKey(options.projectId, engine, session.id), shared);
  return shared;
}
async function openHarnessSession(engine, options) {
  const key = harnessSessionKey(options.projectId, engine, options.sessionId);
  const existing = harnessSessions.get(key);
  if (existing) {
    clearIdle(existing);
    return existing;
  }
  const pending = pendingOpen.get(key) ?? createSession(engine, options);
  pendingOpen.set(key, pending);
  try {
    const shared = await pending;
    clearIdle(shared);
    return shared;
  } finally {
    if (pendingOpen.get(key) === pending) pendingOpen.delete(key);
  }
}
function clearIdle(shared) {
  if (shared.idleTimer) clearTimeout(shared.idleTimer);
  shared.idleTimer = null;
}
function markHarnessActivity(shared, now = Date.now()) {
  shared.lastLocalEventAt = now;
  shared.lastActivityAt = now;
}
function markHarnessInput(shared, now = Date.now()) {
  shared.watchdogStopping = false;
  markHarnessActivity(shared, now);
}
async function compactHarnessSession(shared, compact) {
  let abandon;
  const abandoned = new Promise((_resolve, reject) => {
    abandon = reject;
  });
  const running = compact();
  running.catch(() => {
  });
  shared.compaction = { abandon };
  try {
    await Promise.race([running, abandoned]);
  } finally {
    shared.compaction = void 0;
  }
}
async function reapInactiveHarnessSessions(now = Date.now(), liveShellCallers = /* @__PURE__ */ new Set()) {
  await Promise.all([...harnessSessions.values()].map(async (shared) => {
    if (liveShellCallers.has(JSON.stringify([shared.projectId, shared.conversationId]))) return;
    const timeout = shared.compaction ? COMPACTION_INACTIVITY_TIMEOUT_MS : CONVERSATION_INACTIVITY_TIMEOUT_MS;
    if (shared.watchdogStopping || !harnessTurnBusy(shared) || !conversationInactive(shared.lastActivityAt, now, timeout)) return;
    shared.watchdogStopping = true;
    try {
      shared.compaction?.abandon(new Error(`Compaction stopped after ${Math.round(timeout / 6e4)} minutes without finishing`));
      await shared.session.cancel();
      shared.watchdogStoppedAt = now;
      console.warn(`Stopped inactive ${shared.engine} conversation ${shared.session.id}: no input or output since ${new Date(shared.lastActivityAt).toISOString()}`);
    } catch (error) {
      shared.watchdogStopping = false;
      console.warn(`Could not stop inactive ${shared.engine} conversation ${shared.session.id}`, error);
    } finally {
      sendHarnessStatus(shared);
    }
  }));
}
const ZOMBIE_TURN_GRACE_MS = 10 * 6e4;
function dropZombieHarnessSessions(now = Date.now()) {
  const dropped = [];
  for (const [key, shared] of harnessSessions) {
    if (!shared.watchdogStoppedAt || now - shared.watchdogStoppedAt < ZOMBIE_TURN_GRACE_MS || !harnessTurnBusy(shared)) continue;
    harnessSessions.delete(key);
    clearIdle(shared);
    try {
      shared.unsubscribe();
      shared.session.dispose();
    } catch (error) {
      console.warn(`Could not dispose stuck ${shared.engine} conversation ${shared.session.id}`, error);
    }
    console.warn(`Released stuck ${shared.engine} conversation ${shared.session.id}: still busy ${Math.round((now - shared.watchdogStoppedAt) / 6e4)} minutes after it was stopped`);
    dropped.push(shared);
  }
  return dropped;
}
function attachHarnessClient(shared, socket) {
  clearIdle(shared);
  shared.clients.add(socket);
}
function detachHarnessClient(shared, socket) {
  shared.clients.delete(socket);
  scheduleIdle(shared);
}
function sendHarnessStatus(shared, socket) {
  const clients = socket ? [socket] : shared.clients;
  for (const client of clients) send(client, { type: "status", status: { ...shared.session.status(), backgroundRunning: conversationWorkActive(shared.engine, shared.session.id) } });
  if (!shared.clients.size) scheduleIdle(shared);
}
function scheduleIdle(shared) {
  clearIdle(shared);
  if (findHarnessSession(shared.projectId, shared.engine, shared.session.id) !== shared) return;
  shared.idleTimer = setTimeout(() => {
    if (shared.clients.size || harnessSessionBusy(shared)) return scheduleIdle(shared);
    disposeHarnessSession(shared);
  }, idleSessionTimeoutMs);
  shared.idleTimer.unref();
}
function disposeHarnessSession(shared) {
  if (findHarnessSession(shared.projectId, shared.engine, shared.session.id) !== shared) return;
  if (harnessSessionBusy(shared)) throw new Error("Cannot dispose an active harness session");
  clearIdle(shared);
  shared.unsubscribe();
  shared.session.dispose();
  harnessSessions.delete(harnessSessionKey(shared.projectId, shared.engine, shared.session.id));
}
function refreshHarnessTranscripts(projectId, changedFiles) {
  for (const shared of [...harnessSessions.values()]) {
    if (shared.projectId !== projectId || !shared.session.file || Date.now() - shared.lastLocalEventAt < localWriteGraceMs) continue;
    if (changedFiles.length && !changedFiles.includes(shared.session.file.replace(/^[a-z][a-z0-9-]*:/, ""))) continue;
    if (harnessSessionBusy(shared)) continue;
    const clients = [...shared.clients];
    disposeHarnessSession(shared);
    for (const client of clients) send(client, { type: "sessionFileChanged" });
  }
}
export {
  ZOMBIE_TURN_GRACE_MS,
  attachHarnessClient,
  compactHarnessSession,
  detachHarnessClient,
  disposeHarnessSession,
  dropZombieHarnessSessions,
  findHarnessSession,
  harnessSessionBusy,
  harnessSessionKey,
  harnessSessions,
  harnessTurnBusy,
  historyBeforeLiveTurn,
  listHarnessSessionsRunning,
  markHarnessActivity,
  markHarnessInput,
  openHarnessSession,
  reapInactiveHarnessSessions,
  refreshHarnessTranscripts,
  sendHarnessStatus
};
