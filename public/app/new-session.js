import { harnessIdFromPath, harnessOption } from "../harness-metadata.js";
import { api, savePreferencesInBackground } from "./api.js";
import { classificationPicker } from "./classification.js";
import { conversationTask, loadHarnesses } from "./chat-controls.js";
import { elements } from "./elements.js";
import { rememberDraft } from "./composer.js";
import { selectProject } from "./project-selection.js";
import { brandIcon } from "./icons.js";
import { loadSecretAccounts, openNewSecretAccount, providerBadge, secretAccounts } from "./secrets.js";
import { rememberRecentSession } from "./recents.js";
import { createSearchableSelect } from "./searchable-select.js";
import { renderSessionColorSwatches, selectedSessionColor } from "./session-identity.js";
import { chooseOption, toast } from "./shell.js";
import { openSession } from "./socket.js";
import { state } from "./state.js";
import { cancelHandoffWait } from "./tasks.js";

const classification = classificationPicker(document.querySelector("#newSessionClassification"), "new-session");
const projectPicker = createSearchableSelect({ id: "newSessionProjectSelect", testid: "new-session-project-select", optionTestid: "new-session-project-option", label: "Project", prompt: "Choose a project", placeholder: "Search projects", emptyText: "No projects found" });
document.querySelector("#newSessionProjectPicker").replaceWith(projectPicker.root);
const harnessSelect = document.querySelector("#newSessionHarnessSelect");
let newSessionNodes = [];
let preselectedWorktreeId = null;

/** Worktrees are known for the open project only; another project's conversation runs in its folder. */
function renderNewSessionWorktrees(selected = null) {
  const draft = state.newSessionDraft;
  const worktrees = draft && draft.projectId === state.activeProjectId && !draft.sourceTaskId ? state.worktrees : [];
  elements.newSessionWorktreeLabel.hidden = !worktrees.length;
  elements.newSessionWorktreeSelect.replaceChildren(new Option("Project folder", ""), ...worktrees.map((worktree) => new Option(`Worktree: ${worktree.name}`, worktree.id)));
  elements.newSessionWorktreeSelect.value = worktrees.some((worktree) => worktree.id === selected) ? selected : "";
}

function checkedNewSessionSecretIds() {
  return [...elements.newSessionSecretList.querySelectorAll("input:checked")].map((input) => input.value);
}

/** Re-rendering keeps the ticks already made, so changing the node or adding an account
    never silently drops a pick. */
function renderNewSessionSecrets(selected = checkedNewSessionSecretIds()) {
  elements.newSessionSecretList.replaceChildren();
  if (!secretAccounts.length) {
    elements.newSessionSecretList.textContent = "No node-local secret accounts yet. Add one below.";
    return;
  }
  const remote = elements.newSessionNodeSelect.value !== newSessionNodes.find(node => node.local)?.id;
  // Project-owned accounts are offered only to conversations in their own project.
  for (const account of secretAccounts.filter((account) => !account.projectId || account.projectId === state.newSessionDraft?.projectId)) {
    const item = document.createElement("label");
    item.className = "checkbox-row secret-scope-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = account.id;
    input.checked = selected.includes(account.id);
    input.disabled = remote && account.replicate !== true;
    input.dataset.testid = "conversation-secrets-checkbox";
    const detail = account.websiteOrigin ? ` — ${account.websiteOrigin}` : "";
    item.append(input, providerBadge(account.provider, "secret-scope-provider-badge"), document.createTextNode(` ${account.label}${detail}${input.disabled ? " · local only" : ""}`));
    elements.newSessionSecretList.append(item);
  }
}

// A conversation can need a credential that does not exist yet — a website sign-in most of
// all — so the account is created here and starts ticked.
elements.newSessionSecretAddButton.addEventListener("click", () => {
  const ticked = checkedNewSessionSecretIds();
  openNewSecretAccount((account) => renderNewSessionSecrets([...ticked, account.id]));
});

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

export function addOptimisticSession(sessionId, sessionPath, title, color, classification = null, worktree = undefined) {
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
    ...(worktree ? { worktree: { id: worktree.id, name: worktree.name, color: worktree.color } } : {}),
    createdAt: now,
    updatedAt: now,
    draft: true,
  };
  state.sessions = [session, ...state.sessions.filter((candidate) => candidate.id !== sessionId)];
  rememberRecentSession(session);
}

/** A conversation is named up front so the list shows the user's own label from the first turn. */
async function openNewSessionNameDialog(sessionPath, defaultTitle, sourceTaskId = null, global = false) {
  const projectId = state.activeProjectId;
  const [settings] = await Promise.all([
    api("/api/settings"),
    state.harnesses.length ? undefined : loadHarnesses(),
  ]);
  if (state.activeProjectId !== projectId) return;
  classification.reset(settings.conversationLabels);
  state.newSessionDraft = { sessionPath, defaultTitle, sourceTaskId, projectId: projectId || state.projects[0]?.id };
  document.querySelector("#newSessionProjectLabel").hidden = !document.body.classList.contains("focus-ui");
  projectPicker.setOptions(state.projects.map((project) => ({ value: project.id, label: project.name })));
  projectPicker.setValue(state.newSessionDraft.projectId || "");
  projectPicker.disabled = Boolean(sourceTaskId);
  document.querySelector("#newSessionHarnessLabel").hidden = !global;
  harnessSelect.replaceChildren(...state.harnesses.filter(harness => harness.runtimeConfigured).map(harnessOption));
  harnessSelect.value = state.harnesses.find(harness => harness.newSessionPath === sessionPath)?.id || "";
  elements.newSessionNameInput.value = sourceTaskId ? defaultTitle : "";
  newSessionNodes = [];
  elements.newSessionNodeSelect.replaceChildren();
  renderSessionColorSwatches(null, elements.newSessionColorSwatches);
  renderNewSessionWorktrees(preselectedWorktreeId ?? state.worktreeFilter);
  preselectedWorktreeId = null;
  elements.newSessionSecretList.replaceChildren();
  const draft = state.newSessionDraft;
  loadSecretAccounts().then(() => {
    if (state.newSessionDraft === draft && elements.newSessionNameDialog.open) renderNewSessionSecrets();
  }).catch((error) => toast(error.message));
  elements.newSessionNameDialog.showModal();
  showWizardStep(1);
  await loadNewSessionNodes();
}

async function loadNewSessionNodes() {
  const draft = state.newSessionDraft;
  const projectId = draft?.projectId;
  newSessionNodes = [];
  elements.newSessionNodeSelect.replaceChildren();
  elements.newSessionSecretList.replaceChildren();
  if (!projectId) return;
  const body = await api(`/api/projects/${encodeURIComponent(projectId)}/session-nodes`);
  if (state.newSessionDraft !== draft || draft.projectId !== projectId || !elements.newSessionNameDialog.open) return;
  newSessionNodes = body.nodes;
  elements.newSessionNodeSelect.replaceChildren(...newSessionNodes.map(node => {
    const option = new Option(node.name, node.id);
    option.disabled = !node.online || !node.mapped;
    return option;
  }));
  elements.newSessionNodeSelect.value = (newSessionNodes.find(node => node.local && node.online && node.mapped) || newSessionNodes.find(node => node.online && node.mapped))?.id || "";
  renderNewSessionSecrets([]);
}

export async function startGlobalConversation() {
  if (!state.projects.length) throw new Error("Create a project first");
  if (!state.harnesses.length) await loadHarnesses();
  const available = state.harnesses.filter(harness => harness.ready);
  const harness = available.find(harness => harness.id === state.engine) || available[0];
  if (!harness) throw new Error("No agent is installed and signed in on this node");
  await openNewSessionNameDialog(harness.newSessionPath, `New ${harness.label} conversation`, null, true);
}

projectPicker.onChange((projectId) => {
  if (!state.newSessionDraft || state.newSessionDraft.projectId === projectId) return;
  state.newSessionDraft.projectId = projectId;
  renderNewSessionWorktrees(elements.newSessionWorktreeSelect.value);
  loadNewSessionNodes().catch(error => toast(error.message));
});
harnessSelect.addEventListener("change", () => {
  const harness = state.harnesses.find(item => item.id === harnessSelect.value);
  if (!harness || !state.newSessionDraft) return;
  state.newSessionDraft.sessionPath = harness.newSessionPath;
  state.newSessionDraft.defaultTitle = `New ${harness.label} conversation`;
});
const HARNESS_SHORTCUTS = { pi: "newPiChat", claude: "newClaudeChat", kiro: "newKiroChat" };

export async function startNewHarnessConversation(harnessId) {
  if (!state.harnesses.length) await loadHarnesses();
  const harness = state.harnesses.find((candidate) => candidate.id === harnessId && candidate.runtimeConfigured);
  if (!harness) throw new Error(`Harness ${harnessId} is unavailable`);
  if (!harness.ready) throw new Error(harness.unavailableReason);
  await openNewSessionNameDialog(harness.newSessionPath, `New ${harness.label} conversation`);
}

export function renderNewSessionHarnesses() {
  elements.newSessionHarnesses.replaceChildren(...state.harnesses.filter(({ runtimeConfigured }) => runtimeConfigured).map((harness) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "primary new-chat-harness-button";
    button.disabled = !state.activeProjectId || !state.sessionNodes.length || !harness.ready;
    button.dataset.harnessId = harness.id;
    button.dataset.newSessionHarness = "";
    button.dataset.testid = harness.id === "pi" ? "session-create-button" : harness.id === "claude" ? "session-create-claude-button" : `session-create-${harness.id}-button`;
    if (HARNESS_SHORTCUTS[harness.id]) button.dataset.shortcutHint = HARNESS_SHORTCUTS[harness.id];
    button.setAttribute("aria-label", `New ${harness.label} conversation`);
    button.title = harness.ready ? `New ${harness.label} conversation` : harness.unavailableReason;
    button.append(brandIcon(harness.id, `new-chat-harness-icon ${harness.id}`));
    button.addEventListener("click", () => startNewHarnessConversation(harness.id).catch((error) => toast(error.message)));
    return button;
  }));
  window.dispatchEvent(new CustomEvent("shortcut-targets-changed"));
}

/** Opens the new-conversation dialog with a worktree already chosen as where it runs. */
export async function startNewConversationIn(worktreeId) {
  preselectedWorktreeId = worktreeId;
  try { await chooseNewSessionHarness(); }
  finally { preselectedWorktreeId = null; }
}

async function chooseNewSessionHarness() {
  if (!state.harnesses.length) await loadHarnesses();
  const harnesses = state.harnesses.filter(({ runtimeConfigured }) => runtimeConfigured);
  const harnessId = await chooseOption({
    eyebrow: "New conversation",
    title: "Choose an agent",
    confirmLabel: "Continue",
    options: harnesses.map((harness) => ({ value: harness.id, label: harness.label, icon: brandIcon(harness.id, `choice-option-icon ${harness.id}`), disabled: !harness.ready, hint: harness.ready ? "" : harness.unavailableReason })),
  });
  if (harnessId) await startNewHarnessConversation(harnessId);
}

window.addEventListener("harnesses-changed", renderNewSessionHarnesses);
renderNewSessionHarnesses();
elements.handoffProgressCancelButton.addEventListener("click", cancelHandoffWait);
elements.handoffProgressDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  cancelHandoffWait();
});
elements.newSessionButton.addEventListener("click", () => chooseNewSessionHarness().catch((error) => toast(error.message)));
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
  if (!draft) return;
  const node = newSessionNodes.find((candidate) => candidate.id === elements.newSessionNodeSelect.value);
  if (!node || !node.online || !node.mapped) { showWizardStep(3); toast("Choose an online node with this project mapped"); return; }
  const secretIds = [...elements.newSessionSecretList.querySelectorAll("input:checked:not(:disabled)")].map(input => input.value);
  const worktreeId = elements.newSessionWorktreeLabel.hidden ? null : elements.newSessionWorktreeSelect.value || null;
  const submit = elements.newSessionNameForm.querySelector('[type="submit"]');
  if (submit.disabled) return;
  submit.disabled = true;
  projectPicker.disabled = true;
  harnessSelect.disabled = true;
  try {
    if (classification.needsOther()) showWizardStep(2);
    const label = classification.value();
    const sessionId = crypto.randomUUID();
    const projectId = draft.projectId;
    if (label) await api(`/api/projects/${encodeURIComponent(projectId)}/sessions/classification`, {
      method: "PUT",
      body: JSON.stringify({ sessionId, engine: harnessIdFromPath(state.harnesses, draft.sessionPath || "new"), classification: label }),
    });
    if (!elements.newSessionNameDialog.open || state.newSessionDraft !== draft || draft.projectId !== projectId) return;
    if (state.activeProjectId !== projectId) {
      rememberDraft();
      await selectProject(projectId);
      if (!elements.newSessionNameDialog.open || state.newSessionDraft !== draft || draft.projectId !== projectId) return;
    }
    state.newSessionSecretAccountIds = secretIds;
    state.spinOffSourceTaskId = draft.sourceTaskId;
    state.newSessionWorktreeId = worktreeId;
    state.activeNodeId = node.id;
    if (state.preferencesLoaded) savePreferencesInBackground({ activeNodeId: node.id });
    elements.newSessionNameDialog.close();
    state.newSessionDraft = null;
    state.activeSessionId = sessionId;
    addOptimisticSession(sessionId, draft.sessionPath, title || draft.defaultTitle, color, label, state.worktrees.find((worktree) => worktree.id === worktreeId));
    openSession(draft.sessionPath, title || draft.defaultTitle);
    state.pendingSessionTitle = title || null;
    state.pendingSessionColor = color;
  } catch (error) {
    toast(error.message);
  } finally {
    submit.disabled = false;
    projectPicker.disabled = Boolean(state.newSessionDraft?.sourceTaskId);
    harnessSelect.disabled = false;
  }
});
elements.newSessionNodeSelect.addEventListener("change", () => renderNewSessionSecrets());
