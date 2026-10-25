import { api, savePreferencesInBackground } from "./api.js";
import { reconcileTranscriptConflict } from "./transcript-conflict.js";
import { renderConversationLock } from "./chat-controls.js";
import { elements } from "./elements.js";
import { shortSessionTitle } from "./layout.js";
import { toast } from "./shell.js";
import { openSession } from "./socket.js";
import { shared, state, TAKE_OWNERSHIP_WAIT_SECONDS } from "./state.js";
import { activeChatSession } from "./terminal.js";

function resetOwnershipWait() {
  if (shared.ownershipWait) shared.ownershipWait.resolve(false);
  shared.ownershipWait = null;
  shared.ownershipTaking = false;
  elements.conversationLockStatus.textContent = "";
  renderConversationLock();
}

// Syncthing gives no answer about when the owner node's latest files are here, so a
// takeover of a project on Syncthing counts a grace period down before fencing the owner.
function countdownOwnershipWait(report, waitingFor = "Syncthing") {
  if (shared.ownershipWait) return shared.ownershipWait.promise;
  let seconds = TAKE_OWNERSHIP_WAIT_SECONDS;
  report(`Waiting ${seconds}s for ${waitingFor} to finish…`);
  const wait = { promise: null, resolve: null, settled: false };
  const promise = new Promise((resolve) => {
    const finish = (value) => {
      if (wait.settled) return;
      wait.settled = true;
      clearInterval(interval);
      resolve(value);
    };
    const interval = setInterval(() => {
      seconds -= 1;
      report(seconds ? `Waiting ${seconds}s for ${waitingFor} to finish…` : waitingFor === "Syncthing" ? "Syncthing wait finished." : "Wait finished.");
      if (!seconds) finish(true);
    }, 1000);
    wait.resolve = finish;
  });
  wait.promise = promise;
  shared.ownershipWait = wait;
  return promise;
}

// Longer than this, the takeover goes on with the files already here, as it does when the owner is offline.
const PROJECT_FILES_WAIT_MS = 120_000;

function formatOwnershipBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

// The built-in file sync knows when this node holds every machine's latest files: the
// project's status is checked every second and the wait ends the moment nothing is left
// to copy (at once when nothing was). Errors and missing folders do not hold it either;
// they show on the project as before.
function waitForProjectFiles(projectId, destination, report) {
  if (shared.ownershipWait) return shared.ownershipWait.promise;
  const started = Date.now();
  const wait = { promise: null, resolve: null, settled: false };
  let timer = null;
  wait.promise = new Promise((resolve) => {
    const finish = (value) => {
      if (wait.settled) return;
      wait.settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    wait.resolve = finish;
    const check = async () => {
      let status;
      try { status = (await api(`/api/projects/${encodeURIComponent(projectId)}`)).project?.syncStatus; } catch { status = undefined; }
      if (wait.settled) return;
      if (status?.state !== "syncing" || Date.now() - started > PROJECT_FILES_WAIT_MS) { finish(true); return; }
      const files = status.remainingFiles;
      report(files ? `Copying files to ${destination.name}: ${files} ${files === 1 ? "file" : "files"}, ${formatOwnershipBytes(status.remainingBytes)} left…` : `${status.message || "Checking files"}…`);
      timer = setTimeout(check, 1000);
    };
    report("Checking files…");
    void check();
  });
  shared.ownershipWait = wait;
  return wait.promise;
}

function waitForLockOwnershipSync(projectId, destination) {
  elements.conversationLockTakeButton.disabled = true;
  const report = (text) => { elements.conversationLockStatus.textContent = text; };
  const engine = state.projects.find((project) => project.id === projectId)?.syncStatus?.engine;
  if (!engine) return countdownOwnershipWait(report);
  // The status this page can read is this node's; for another destination only the grace period is left.
  return destination.local ? waitForProjectFiles(projectId, destination, report) : countdownOwnershipWait(report, "files");
}

// Takeover continues the conversation on this node's own filesystem: the
// transcript and the project's files are expected here already, and only the
// write lock moves.
async function takeLockedConversationOwnership() {
  const session = activeChatSession();
  if (shared.ownershipWait || shared.ownershipTaking || state.activeTaskId || !state.activeProjectId || !session) return;
  const projectId = state.activeProjectId;
  const destination = state.sessionNodes.find((node) => node.id === state.activeNodeId);
  if (!destination?.mapped) throw new Error("Map project first on this node");
  const proceed = await waitForLockOwnershipSync(projectId, destination);
  if (!proceed) return;
  shared.ownershipTaking = true;
  elements.conversationLockStatus.textContent = "Taking ownership…";
  try {
    const result = await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/sessions/take-ownership`, {
      method: "POST", body: JSON.stringify({ peerId: destination.id, sessionId: session.id, sessionPath: session.path, sessionName: shortSessionTitle(session) }),
    });
    state.activeNodeId = destination.id;
    state.activeSessionId = null;
    if (state.preferencesLoaded) savePreferencesInBackground({ activeNodeId: destination.id, activeSessionId: null });
    resetOwnershipWait();
    openSession(result.sessionPath, shortSessionTitle(session));
    toast(result.pendingPeerIds?.length ? "Ownership taken; offline nodes will update when they return" : "Ownership taken");
  } catch (error) {
    resetOwnershipWait();
    if (!await reconcileTranscriptConflict(error, { projectId, engine: session.harnessId, sessionId: session.id })) throw error;
  }
}

elements.conversationLockTakeButton.addEventListener("click", () => takeLockedConversationOwnership().catch((error) => { resetOwnershipWait(); toast(error.message, 8000); }));
