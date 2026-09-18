import WebSocket from "ws";
import { conversationWorkActive } from "../conversation-work.js";
import { getHarness, getHarnessRuntime, refreshHarnessSessions } from "../harnesses.js";
import type { HarnessEvent, HarnessOpenOptions, HarnessSession } from "../harnesses/runtime.js";
import type { HarnessId } from "../types.js";
import { broadcastToProject, scheduleReviewNotifications, send } from "./realtime.js";
import { idleSessionTimeoutMs, localWriteGraceMs } from "./state.js";

export interface SharedHarnessSession {
  engine: HarnessId; projectId: string; cwd: string; session: HarnessSession;
  clients: Set<WebSocket>; turnInFlight: number; lastLocalEventAt: number; internalTurn?: boolean;
  liveEvents: HarnessEvent[]; idleTimer: NodeJS.Timeout | null; unsubscribe: () => void;
  /** True while the running turn came from a scheduled task rather than a person. */
  scheduledTurn: boolean;
}

export const harnessSessions = new Map<string, SharedHarnessSession>();
const pendingOpen = new Map<string, Promise<SharedHarnessSession>>();

export function harnessSessionKey(projectId: string, engine: HarnessId, sessionId: string): string {
  return JSON.stringify([projectId, engine, sessionId]);
}

export function findHarnessSession(projectId: string, engine: HarnessId, id: string): SharedHarnessSession | undefined {
  return harnessSessions.get(harnessSessionKey(projectId, engine, id));
}

export function harnessTurnBusy(shared: SharedHarnessSession): boolean {
  return shared.turnInFlight > 0 || shared.session.isBusy();
}

export function harnessSessionBusy(shared: SharedHarnessSession): boolean {
  return harnessTurnBusy(shared) || conversationWorkActive(shared.engine, shared.session.id);
}

export function listHarnessSessionsRunning(): SharedHarnessSession[] {
  return [...harnessSessions.values()].filter(harnessSessionBusy);
}

function appendEvent(events: HarnessEvent[], event: HarnessEvent): void {
  const previous = events.at(-1);
  const delta = event.type === "textDelta" || event.type === "thinkingDelta";
  if (delta && previous && previous.type === event.type && typeof previous.text === "string" && typeof event.text === "string") {
    previous.text += event.text;
  } else events.push({ ...event });
}

function subscribe(shared: SharedHarnessSession): () => void {
  let announcedFile: string | undefined;
  return shared.session.subscribe((event) => {
    const internal = shared.internalTurn === true;
    shared.lastLocalEventAt = Date.now();
    if (event.type === "agent_start") shared.liveEvents = [];
    if (!internal && shared.turnInFlight) appendEvent(shared.liveEvents, event);
    if (!internal) for (const client of shared.clients) send(client, event);
    const file = shared.session.file;
    if (event.type === "sessionFile" && typeof event.sessionFile === "string") announcedFile = event.sessionFile;
    if (file && file !== announcedFile && event.type !== "sessionFile") {
      announcedFile = file;
      if (!internal) for (const client of shared.clients) send(client, { type: "sessionFile", sessionId: shared.session.id, sessionFile: file });
    }
    if (event.type === "agent_start" || event.type === "status" || event.type === "conversationWorkChanged") broadcastToProject(shared.projectId, { type: "sessionsChanged" });
    if (!internal && event.type === "conversationWorkChanged") scheduleReviewNotifications(shared.projectId);
    if (event.type === "agent_end") {
      shared.liveEvents = [];
      const refreshFile = file ? getHarness(shared.engine).paths.transcriptFile?.(file) ?? file : undefined;
      const refresh = refreshHarnessSessions(shared.projectId, refreshFile ? [refreshFile] : []);
      void refresh.then(() => {
        broadcastToProject(shared.projectId, { type: "sessionsChanged" });
        if (!internal) scheduleReviewNotifications(shared.projectId);
      }).catch((error) => console.error("Could not refresh completed harness session", error));
    }
    if (["agent_start", "agent_end", "status", "configuration", "sessionFile", "conversationWorkChanged"].includes(String(event.type))) sendHarnessStatus(shared);
  });
}

async function createSession(engine: HarnessId, options: HarnessOpenOptions): Promise<SharedHarnessSession> {
  const session = await (await getHarnessRuntime(engine)).open(options);
  if (session.id !== options.sessionId) throw new Error(`Harness returned unexpected session ID: ${session.id}`);
  const shared: SharedHarnessSession = { engine, projectId: options.projectId, cwd: options.cwd, session, clients: new Set(), turnInFlight: 0, lastLocalEventAt: 0, liveEvents: [], idleTimer: null, unsubscribe: () => {}, scheduledTurn: false };
  shared.unsubscribe = subscribe(shared);
  harnessSessions.set(harnessSessionKey(options.projectId, engine, session.id), shared);
  return shared;
}

export async function openHarnessSession(engine: HarnessId, options: HarnessOpenOptions): Promise<SharedHarnessSession> {
  const key = harnessSessionKey(options.projectId, engine, options.sessionId);
  const existing = harnessSessions.get(key);
  if (existing) { clearIdle(existing); return existing; }
  const pending = pendingOpen.get(key) ?? createSession(engine, options);
  pendingOpen.set(key, pending);
  try { const shared = await pending; clearIdle(shared); return shared; }
  finally { if (pendingOpen.get(key) === pending) pendingOpen.delete(key); }
}

function clearIdle(shared: SharedHarnessSession): void {
  if (shared.idleTimer) clearTimeout(shared.idleTimer);
  shared.idleTimer = null;
}

export function attachHarnessClient(shared: SharedHarnessSession, socket: WebSocket): void { clearIdle(shared); shared.clients.add(socket); }
export function detachHarnessClient(shared: SharedHarnessSession, socket: WebSocket): void { shared.clients.delete(socket); scheduleIdle(shared); }
export function sendHarnessStatus(shared: SharedHarnessSession, socket?: WebSocket): void {
  const clients = socket ? [socket] : shared.clients;
  for (const client of clients) send(client, { type: "status", status: { ...shared.session.status(), backgroundRunning: conversationWorkActive(shared.engine, shared.session.id) } });
  if (!shared.clients.size) scheduleIdle(shared);
}

function scheduleIdle(shared: SharedHarnessSession): void {
  clearIdle(shared);
  if (findHarnessSession(shared.projectId, shared.engine, shared.session.id) !== shared) return;
  shared.idleTimer = setTimeout(() => {
    if (shared.clients.size || harnessSessionBusy(shared)) return scheduleIdle(shared);
    disposeHarnessSession(shared);
  }, idleSessionTimeoutMs);
  shared.idleTimer.unref();
}

export function disposeHarnessSession(shared: SharedHarnessSession): void {
  if (findHarnessSession(shared.projectId, shared.engine, shared.session.id) !== shared) return;
  if (harnessSessionBusy(shared)) throw new Error("Cannot dispose an active harness session");
  clearIdle(shared); shared.unsubscribe(); shared.session.dispose();
  harnessSessions.delete(harnessSessionKey(shared.projectId, shared.engine, shared.session.id));
}

export function refreshHarnessTranscripts(projectId: string, changedFiles: string[]): void {
  for (const shared of [...harnessSessions.values()]) {
    if (shared.projectId !== projectId || !shared.session.file || Date.now() - shared.lastLocalEventAt < localWriteGraceMs) continue;
    if (changedFiles.length && !changedFiles.includes(shared.session.file.replace(/^[a-z][a-z0-9-]*:/, ""))) continue;
    if (harnessSessionBusy(shared)) continue;
    const clients = [...shared.clients]; disposeHarnessSession(shared);
    for (const client of clients) send(client, { type: "sessionFileChanged" });
  }
}
