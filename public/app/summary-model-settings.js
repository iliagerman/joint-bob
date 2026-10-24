import { harnessOption } from "../harness-metadata.js";
import { loadConversationChatSettings } from "./conversation-chat.js";
import { api } from "./api.js";
import { elements } from "./elements.js";
import { fillModelOptions, fillThinkingOptions, selectedModel } from "./git-reviewer-options.js";
import { isNodeAdmin } from "./node-admin.js";
import { toast } from "./shell.js";

// Settings → Conversations → Activity summary: when this machine updates conversation
// summaries, which agent, model and effort write them, and the instructions they follow.
// It is the machine's setting, so only its admin changes it; a relay this machine has joined
// can set when and who for every member instead, and a machine that serves a relay can
// publish its own choice to the relay's machines. The instructions stay this machine's own.

const choices = { harnesses: [], models: [] };
const instructions = { custom: null, default: "" };
const skillInstructions = { custom: null, default: "" };

function showSkillInstructions(saved = false) {
  elements.settingsSkillInstructions.value = skillInstructions.custom ?? skillInstructions.default;
  elements.settingsSkillInstructionsStatus.textContent = `${saved ? "Saved · " : ""}${skillInstructions.custom ? "this machine's own instructions" : "built-in instructions"}`;
  elements.settingsSkillInstructions.disabled = !isNodeAdmin();
  elements.settingsSkillInstructionsReset.disabled = !skillInstructions.custom || !isNodeAdmin();
}

async function saveSkillInstructions(text) {
  try {
    const body = await api("/api/conversation-summary/skill-instructions", { method: "PUT", body: JSON.stringify({ instructions: text }) });
    Object.assign(skillInstructions, body.skillInstructions);
    showSkillInstructions(true);
  } catch (error) {
    toast(error.message || "Could not save the skill suggestion instructions");
  }
}

elements.settingsSkillInstructions.addEventListener("change", () => {
  const text = elements.settingsSkillInstructions.value.trim();
  void saveSkillInstructions(text && text !== skillInstructions.default ? text : null);
});
elements.settingsSkillInstructionsReset.addEventListener("click", () => void saveSkillInstructions(null));

function chosenHarness() {
  return choices.harnesses.find((harness) => harness.id === elements.settingsSummaryHarness.value);
}

/** The agent, model and effort pickers belong to the "chosen here" writer only. */
function showChosenPickers() {
  const fixed = elements.settingsSummaryWriter.value === "fixed";
  for (const label of [elements.settingsSummaryHarnessLabel, elements.settingsSummaryModelLabel, elements.settingsSummaryThinkingLabel]) label.hidden = !fixed;
}

function policyFromForm() {
  const harness = chosenHarness();
  const source = elements.settingsSummaryWriter.value;
  let writer = { source: source === "conversation" ? "conversation" : "automatic" };
  if (source === "fixed" && harness) {
    const { provider, modelId } = selectedModel(elements.settingsSummaryModel);
    writer = { source: "fixed", harnessId: harness.id, ...(provider ? { provider } : {}), modelId, thinkingLevel: elements.settingsSummaryThinking.value };
  }
  return { updates: elements.settingsSummaryUpdates.value, writer };
}

async function saveSummaryPolicy() {
  const policy = policyFromForm();
  try {
    await api("/api/conversation-summary/settings", { method: "PUT", body: JSON.stringify(policy) });
    if (elements.settingsSummaryRelayApply.checked) await api("/api/conversation-summary/relay-policy", { method: "PUT", body: JSON.stringify({ policy }) });
    document.dispatchEvent(new CustomEvent("summary-policy-changed"));
  } catch (error) {
    console.warn("Could not save the summary settings", error);
    toast(error.message || "Could not save the summary settings");
  }
}

function fillForm(policy) {
  elements.settingsSummaryUpdates.value = policy.updates;
  const writer = policy.writer;
  const fixed = writer.source === "fixed" && choices.harnesses.some((harness) => harness.id === writer.harnessId);
  elements.settingsSummaryWriter.value = fixed ? "fixed" : writer.source === "conversation" ? "conversation" : "automatic";
  elements.settingsSummaryHarness.value = fixed ? writer.harnessId : choices.harnesses[0]?.id ?? "";
  const harness = chosenHarness();
  if (harness) fillModelOptions(harness, choices.models, elements.settingsSummaryModel, elements.settingsSummaryThinking, fixed ? writer : {});
  showChosenPickers();
}

function showInstructions(saved = false) {
  elements.settingsSummaryInstructions.value = instructions.custom ?? instructions.default;
  elements.settingsSummaryInstructionsStatus.textContent = `${saved ? "Saved · " : ""}${instructions.custom ? "this machine's own instructions" : "built-in instructions"}`;
  elements.settingsSummaryInstructionsReset.disabled = !instructions.custom || !isNodeAdmin();
}

async function saveInstructions(text) {
  try {
    const body = await api("/api/conversation-summary/instructions", { method: "PUT", body: JSON.stringify({ instructions: text }) });
    Object.assign(instructions, body.instructions);
    showInstructions(true);
  } catch (error) {
    console.warn("Could not save the summary instructions", error);
    toast(error.message || "Could not save the summary instructions");
  }
}

export async function loadSummaryModelSettings() {
  await loadConversationChatSettings();
  const [harnessBody, modelBody, settings] = await Promise.all([api("/api/harnesses"), api("/api/models"), api("/api/conversation-summary/settings")]);
  choices.harnesses = harnessBody.harnesses.filter((harness) => harness.runtimeConfigured);
  choices.models = modelBody.models;
  elements.settingsSummaryHarness.replaceChildren(...choices.harnesses.map(harnessOption));
  elements.settingsSummaryWriter.querySelector("option[value='fixed']").disabled = !choices.harnesses.length;
  fillForm(settings.node);
  Object.assign(instructions, settings.instructions);
  Object.assign(skillInstructions, settings.skillInstructions);
  showSkillInstructions();
  const relay = settings.effective.from.kind === "relay" ? settings.effective.from.relay : "";
  elements.settingsSummaryRelayNote.hidden = !relay;
  elements.settingsSummaryRelayNote.textContent = relay ? `The relay ${relay} sets this for its machines: ${settings.effective.view.updates === "each-message" ? "after each message" : settings.effective.view.updates === "panel" ? "while the panel is open" : "only when asked"}, written by ${settings.effective.view.writer}. This machine's own choice below applies if it leaves that relay.` : "";
  elements.settingsSummaryRelay.hidden = !settings.relayServing;
  elements.settingsSummaryRelayApply.checked = Boolean(settings.relayServing?.policy);
  const admin = isNodeAdmin();
  for (const control of [elements.settingsSummaryUpdates, elements.settingsSummaryWriter, elements.settingsSummaryHarness, elements.settingsSummaryModel, elements.settingsSummaryThinking, elements.settingsSummaryRelayApply, elements.settingsSummaryInstructions]) control.disabled = !admin;
  showInstructions();
}

elements.settingsSummaryUpdates.addEventListener("change", saveSummaryPolicy);
elements.settingsSummaryWriter.addEventListener("change", () => {
  const harness = chosenHarness();
  if (elements.settingsSummaryWriter.value === "fixed" && harness) fillModelOptions(harness, choices.models, elements.settingsSummaryModel, elements.settingsSummaryThinking);
  showChosenPickers();
  void saveSummaryPolicy();
});
elements.settingsSummaryHarness.addEventListener("change", () => {
  const harness = chosenHarness();
  if (harness) fillModelOptions(harness, choices.models, elements.settingsSummaryModel, elements.settingsSummaryThinking);
  void saveSummaryPolicy();
});
elements.settingsSummaryModel.addEventListener("change", () => {
  fillThinkingOptions(chosenHarness(), choices.models, elements.settingsSummaryModel, elements.settingsSummaryThinking, elements.settingsSummaryThinking.value);
  void saveSummaryPolicy();
});
elements.settingsSummaryThinking.addEventListener("change", saveSummaryPolicy);
elements.settingsSummaryRelayApply.addEventListener("change", async () => {
  try {
    await api("/api/conversation-summary/relay-policy", { method: "PUT", body: JSON.stringify({ policy: elements.settingsSummaryRelayApply.checked ? policyFromForm() : null }) });
  } catch (error) {
    elements.settingsSummaryRelayApply.checked = !elements.settingsSummaryRelayApply.checked;
    toast(error.message || "Could not update the relay's summary policy");
  }
});
// Saved when the box loses focus with a change; empty text goes back to the built-in instructions.
elements.settingsSummaryInstructions.addEventListener("change", () => {
  const text = elements.settingsSummaryInstructions.value.trim();
  void saveInstructions(text && text !== instructions.default ? text : null);
});
elements.settingsSummaryInstructionsReset.addEventListener("click", () => void saveInstructions(null));
