import { savePreferencesInBackground } from "./api.js";
import { conversationTask } from "./chat-controls.js";
import { elements } from "./elements.js";
import { loadSecretAccounts, providerBadge, secretAccounts } from "./secrets.js";
import { renderSessionColorSwatches, selectedSessionColor } from "./session-identity.js";
import { toast } from "./shell.js";
import { openSession } from "./socket.js";
import { state } from "./state.js";
import { cancelHandoffWait } from "./tasks.js";

/** The environment is composed once, at spawn, so the accounts have to be chosen before the
    conversation starts rather than attached to it afterwards. */
function localSessionNode() {
  return state.sessionNodes.find((node) => node.local);
}

function renderNewSessionSecrets() {
  elements.newSessionSecretList.replaceChildren();
  if (!secretAccounts.length) {
    elements.newSessionSecretList.textContent = "No node-local secret accounts. Add one in Settings.";
    return;
  }
  const remote = elements.newSessionNodeSelect.value !== localSessionNode()?.id;
  for (const account of secretAccounts) {
    const item = document.createElement("label");
    item.className = "checkbox-row secret-scope-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = account.id;
    input.disabled = remote && account.replicate !== true;
    input.dataset.testid = "conversation-secrets-checkbox";
    item.append(input, providerBadge(account.provider, "secret-scope-provider-badge"), document.createTextNode(` ${account.label}${input.disabled ? " · local only" : ""}`));
    elements.newSessionSecretList.append(item);
  }
}

export function addOptimisticSession(sessionId, sessionPath, title, color) {
  const newSessionPath = sessionPath || "new";
  const harness = state.harnesses.find((candidate) => candidate.newSessionPath === newSessionPath);
  if (!harness) throw new Error(`No harness owns new-session path: ${newSessionPath}`);
  const now = new Date().toISOString();
  state.sessions = [{
    id: sessionId,
    path: `draft:${harness.id}:${sessionId}`,
    harnessId: harness.id,
    agentId: harness.id,
    agentLabel: harness.label,
    title,
    color,
    createdAt: now,
    updatedAt: now,
    draft: true,
  }, ...state.sessions.filter((session) => session.id !== sessionId)];
}

/** A conversation is named up front so the list shows the user's own label from the first turn. */
function openNewSessionNameDialog(sessionPath, defaultTitle, sourceTaskId = null) {
  state.newSessionDraft = { sessionPath, defaultTitle, sourceTaskId };
  elements.newSessionNameInput.value = sourceTaskId ? defaultTitle : "";
  elements.newSessionNodeSelect.replaceChildren(...state.sessionNodes.map((node) => {
    const option = document.createElement("option");
    option.value = node.id;
    option.textContent = node.name;
    option.disabled = !node.online || !node.mapped;
    return option;
  }));
  elements.newSessionNodeSelect.value = localSessionNode()?.id ?? "";
  renderSessionColorSwatches(null, elements.newSessionColorSwatches);
  elements.newSessionSecretList.replaceChildren();
  loadSecretAccounts().then(renderNewSessionSecrets).catch((error) => toast(error.message));
  elements.newSessionNameDialog.showModal();
}
elements.handoffProgressCancelButton.addEventListener("click", cancelHandoffWait);
elements.handoffProgressDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  cancelHandoffWait();
});
elements.newSessionButton.addEventListener("click", () => openNewSessionNameDialog(null, "New Pi conversation"));
elements.newClaudeSessionButton.addEventListener("click", () => openNewSessionNameDialog("claude:new", "New Claude conversation"));
elements.doneConversationContinueButton.addEventListener("click", () => {
  const task = conversationTask();
  if (!task || task.status !== "done") throw new Error("Done ticket was not found");
  const harness = state.harnesses.find((candidate) => candidate.id === state.engine);
  if (!harness) throw new Error(`Harness ${state.engine} was not found`);
  openNewSessionNameDialog(harness.newSessionPath, `Follow-up: ${task.title}`, task.id);
});
elements.cancelNewSessionNameButton.addEventListener("click", () => elements.newSessionNameDialog.close());
elements.newSessionNameForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const draft = state.newSessionDraft;
  const title = elements.newSessionNameInput.value.trim();
  const color = selectedSessionColor(elements.newSessionColorSwatches);
  const node = state.sessionNodes.find((candidate) => candidate.id === elements.newSessionNodeSelect.value);
  if (!node || !node.online || !node.mapped) { toast("Choose an online node with this project mapped"); return; }
  state.newSessionSecretAccountIds = [...elements.newSessionSecretList.querySelectorAll("input:checked")].map((input) => input.value);
  state.spinOffSourceTaskId = draft.sourceTaskId;
  state.activeNodeId = node.id;
  if (state.preferencesLoaded) savePreferencesInBackground({ activeNodeId: node.id });
  elements.newSessionNameDialog.close();
  state.newSessionDraft = null;
  state.activeSessionId = crypto.randomUUID();
  addOptimisticSession(state.activeSessionId, draft.sessionPath, title || draft.defaultTitle, color);
  openSession(draft.sessionPath, title || draft.defaultTitle);
  state.pendingSessionTitle = title || null;
  state.pendingSessionColor = color;
});
elements.newSessionNodeSelect.addEventListener("change", renderNewSessionSecrets);
