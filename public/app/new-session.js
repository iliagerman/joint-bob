import { api, savePreferencesInBackground } from "./api.js";
import { classificationPicker } from "./classification.js";
import { conversationTask } from "./chat-controls.js";
import { elements } from "./elements.js";
import { loadSecretAccounts, providerBadge, secretAccounts } from "./secrets.js";
import { rememberRecentSession } from "./recents.js";
import { renderSessionColorSwatches, selectedSessionColor } from "./session-identity.js";
import { toast } from "./shell.js";
import { openSession } from "./socket.js";
import { state } from "./state.js";
import { cancelHandoffWait } from "./tasks.js";

const classification = classificationPicker(document.querySelector("#newSessionClassification"), "new-session");

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

/** The dialog is a three-step wizard so a conversation is set up one decision at a
    time, and every step is reachable from the keyboard alone: Enter walks forward,
    Cmd/Ctrl+Enter starts straight away with whatever has been chosen so far. */
const WIZARD_STEPS = [
  {
    title: "Name this conversation",
    hint: "The name shows in your conversation list from now on. Leave it blank to keep the automatic title.",
    focus: () => elements.newSessionNameInput,
  },
  {
    title: "Classify this conversation",
    hint: "A label groups the conversation in the list and in the filters. Skip it to leave it unclassified.",
    focus: () => elements.newSessionNameForm.querySelector('[data-testid="new-session-classification-select"]'),
  },
  {
    title: "Choose where it runs",
    hint: "The node runs the conversation, and its secret accounts are composed into the environment at spawn.",
    focus: () => elements.newSessionNodeSelect,
  },
];
let wizardStep = 1;

function showWizardStep(step) {
  wizardStep = Math.min(Math.max(step, 1), WIZARD_STEPS.length);
  const current = WIZARD_STEPS[wizardStep - 1];
  elements.newSessionStepTitle.textContent = current.title;
  elements.newSessionStepHint.textContent = current.hint;
  for (const panel of elements.newSessionNameForm.querySelectorAll(".wizard-panel")) {
    panel.hidden = Number(panel.dataset.step) !== wizardStep;
  }
  for (const marker of elements.newSessionStepList.querySelectorAll(".wizard-step")) {
    const step = Number(marker.dataset.step);
    marker.classList.toggle("active", step === wizardStep);
    marker.classList.toggle("done", step < wizardStep);
    marker.setAttribute("aria-current", step === wizardStep ? "step" : "false");
  }
  elements.newSessionBackButton.disabled = wizardStep === 1;
  elements.newSessionNextButton.disabled = wizardStep === WIZARD_STEPS.length;
  current.focus()?.focus();
}

export function addOptimisticSession(sessionId, sessionPath, title, color, classification = null) {
  const newSessionPath = sessionPath || "new";
  const harness = state.harnesses.find((candidate) => candidate.newSessionPath === newSessionPath);
  if (!harness) throw new Error(`No harness owns new-session path: ${newSessionPath}`);
  const now = new Date().toISOString();
  const session = {
    id: sessionId,
    path: `draft:${harness.id}:${sessionId}`,
    harnessId: harness.id,
    agentId: harness.id,
    agentLabel: harness.label,
    title,
    color,
    classification,
    createdAt: now,
    updatedAt: now,
    draft: true,
  };
  state.sessions = [session, ...state.sessions.filter((candidate) => candidate.id !== sessionId)];
  rememberRecentSession(session);
}

/** A conversation is named up front so the list shows the user's own label from the first turn. */
async function openNewSessionNameDialog(sessionPath, defaultTitle, sourceTaskId = null) {
  const projectId = state.activeProjectId;
  const settings = await api("/api/settings");
  if (state.activeProjectId !== projectId) return;
  classification.reset(settings.conversationLabels);
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
  showWizardStep(1);
}
elements.handoffProgressCancelButton.addEventListener("click", cancelHandoffWait);
elements.handoffProgressDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  cancelHandoffWait();
});
elements.newSessionButton.addEventListener("click", () => openNewSessionNameDialog(null, "New Pi conversation").catch((error) => toast(error.message)));
elements.newClaudeSessionButton.addEventListener("click", () => openNewSessionNameDialog("claude:new", "New Claude conversation").catch((error) => toast(error.message)));
elements.doneConversationContinueButton.addEventListener("click", () => {
  const task = conversationTask();
  if (!task || task.status !== "done") throw new Error("Done ticket was not found");
  const harness = state.harnesses.find((candidate) => candidate.id === state.engine);
  if (!harness) throw new Error(`Harness ${state.engine} was not found`);
  openNewSessionNameDialog(harness.newSessionPath, `Follow-up: ${task.title}`, task.id).catch((error) => toast(error.message));
});
elements.cancelNewSessionNameButton.addEventListener("click", () => elements.newSessionNameDialog.close());
elements.newSessionBackButton.addEventListener("click", () => showWizardStep(wizardStep - 1));
elements.newSessionNextButton.addEventListener("click", () => showWizardStep(wizardStep + 1));
for (const marker of elements.newSessionStepList.querySelectorAll(".wizard-step")) {
  marker.addEventListener("click", () => showWizardStep(Number(marker.dataset.step)));
}
// Enter walks the wizard forward; only the last step, or Cmd/Ctrl+Enter, submits it.
elements.newSessionNameForm.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing) return;
  if (event.target instanceof HTMLButtonElement) return;
  if (event.metaKey || event.ctrlKey || wizardStep === WIZARD_STEPS.length) return;
  event.preventDefault();
  showWizardStep(wizardStep + 1);
});
elements.newSessionNameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const draft = state.newSessionDraft;
  const title = elements.newSessionNameInput.value.trim();
  const color = selectedSessionColor(elements.newSessionColorSwatches);
  const node = state.sessionNodes.find((candidate) => candidate.id === elements.newSessionNodeSelect.value);
  if (!node || !node.online || !node.mapped) { toast("Choose an online node with this project mapped"); return; }
  const submit = elements.newSessionNameForm.querySelector('[type="submit"]');
  if (submit.disabled) return;
  submit.disabled = true;
  try {
    if (classification.needsOther()) showWizardStep(2);
    const label = classification.value();
    const sessionId = crypto.randomUUID();
    const projectId = state.activeProjectId;
    if (label) await api(`/api/projects/${encodeURIComponent(projectId)}/sessions/classification`, {
      method: "PUT",
      body: JSON.stringify({ sessionId, engine: draft.sessionPath === "claude:new" ? "claude" : "pi", classification: label }),
    });
    if (!elements.newSessionNameDialog.open || state.newSessionDraft !== draft || state.activeProjectId !== projectId) return;
    state.newSessionSecretAccountIds = [...elements.newSessionSecretList.querySelectorAll("input:checked")].map((input) => input.value);
    state.spinOffSourceTaskId = draft.sourceTaskId;
    state.activeNodeId = node.id;
    if (state.preferencesLoaded) savePreferencesInBackground({ activeNodeId: node.id });
    elements.newSessionNameDialog.close();
    state.newSessionDraft = null;
    state.activeSessionId = sessionId;
    addOptimisticSession(sessionId, draft.sessionPath, title || draft.defaultTitle, color, label);
    openSession(draft.sessionPath, title || draft.defaultTitle);
    state.pendingSessionTitle = title || null;
    state.pendingSessionColor = color;
  } catch (error) {
    toast(error.message);
  } finally {
    submit.disabled = false;
  }
});
elements.newSessionNodeSelect.addEventListener("change", renderNewSessionSecrets);
