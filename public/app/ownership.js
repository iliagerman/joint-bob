import { api, savePreferencesInBackground } from "./api.js";
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

// Syncthing may still be copying the owner node's transcript, so the takeover
// counts a grace period down before fencing the owner.
function countdownOwnershipWait(report) {
  if (shared.ownershipWait) return shared.ownershipWait.promise;
  let seconds = TAKE_OWNERSHIP_WAIT_SECONDS;
  report(`Waiting ${seconds}s for Syncthing to finish…`);
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
      report(seconds ? `Waiting ${seconds}s for Syncthing to finish…` : "Syncthing wait finished.");
      if (!seconds) finish(true);
    }, 1000);
    wait.resolve = finish;
  });
  wait.promise = promise;
  shared.ownershipWait = wait;
  return promise;
}

function waitForLockOwnershipSync() {
  elements.conversationLockTakeButton.disabled = true;
  return countdownOwnershipWait((text) => { elements.conversationLockStatus.textContent = text; });
}

// Takeover continues the conversation on this node's own filesystem: the
// transcript is assumed already replicated by Syncthing, and only the write
// lock moves.
async function takeLockedConversationOwnership() {
  const session = activeChatSession();
  if (shared.ownershipWait || shared.ownershipTaking || state.activeTaskId || !state.activeProjectId || !session) return;
  const destination = state.sessionNodes.find((node) => node.id === state.activeNodeId);
  if (!destination?.mapped) throw new Error("Map project first on this node");
  const proceed = await waitForLockOwnershipSync();
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
    openSession(result.sessionPath, shortSessionTitle(session));
    toast(result.pendingPeerIds?.length ? "Ownership taken; offline nodes will update when they return" : "Ownership taken");
  } catch (error) { resetOwnershipWait(); throw error; }
}

elements.conversationLockTakeButton.addEventListener("click", () => takeLockedConversationOwnership().catch((error) => { resetOwnershipWait(); toast(error.message, 8000); }));
