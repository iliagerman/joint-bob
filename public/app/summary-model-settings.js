import { harnessOption } from "../harness-metadata.js";
import { api } from "./api.js";
import { elements } from "./elements.js";
import { fillModelOptions, fillThinkingOptions, selectedModel } from "./git-reviewer-options.js";
import { isNodeAdmin } from "./node-admin.js";
import { toast } from "./shell.js";

// Settings → Conversations → Activity summary: when this machine updates conversation
// summaries and which agent writes them. It is the machine's setting, so only its admin
// changes it; a relay this machine has joined can set it for every member instead, and a
// machine that serves a relay can publish its own choice to the relay's machines.

const choices = { harnesses: [], models: [] };

function chosenHarness() {
  return choices.harnesses.find((harness) => harness.id === elements.settingsSummaryHarness.value);
}

function showModelPickers(visible) {
  elements.settingsSummaryModelLabel.hidden = !visible;
  elements.settingsSummaryThinkingLabel.hidden = !visible;
}

function policyFromForm() {
  const source = elements.settingsSummaryHarness.value;
  const harness = chosenHarness();
  const writer = harness
    ? { source: "fixed", harnessId: harness.id, ...(selectedModel(elements.settingsSummaryModel).provider ? { provider: selectedModel(elements.settingsSummaryModel).provider } : {}), modelId: selectedModel(elements.settingsSummaryModel).modelId, thinkingLevel: elements.settingsSummaryThinking.value }
    : { source: source === "conversation" ? "conversation" : "automatic" };
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
  elements.settingsSummaryHarness.value = fixed ? writer.harnessId : writer.source === "conversation" ? "conversation" : "automatic";
  const harness = chosenHarness();
  showModelPickers(Boolean(harness));
  if (harness) fillModelOptions(harness, choices.models, elements.settingsSummaryModel, elements.settingsSummaryThinking, fixed ? writer : {});
}

export async function loadSummaryModelSettings() {
  const [harnessBody, modelBody, settings] = await Promise.all([api("/api/harnesses"), api("/api/models"), api("/api/conversation-summary/settings")]);
  choices.harnesses = harnessBody.harnesses.filter((harness) => harness.runtimeConfigured);
  choices.models = modelBody.models;
  elements.settingsSummaryHarness.replaceChildren(
    new Option("Automatic: routing classifier, else the conversation's model", "automatic"),
    new Option("Same as conversation", "conversation"),
    ...choices.harnesses.map(harnessOption),
  );
  fillForm(settings.node);
  const relay = settings.effective.from.kind === "relay" ? settings.effective.from.relay : "";
  elements.settingsSummaryRelayNote.hidden = !relay;
  elements.settingsSummaryRelayNote.textContent = relay ? `The relay ${relay} sets this for its machines: ${settings.effective.view.updates === "each-message" ? "after each message" : settings.effective.view.updates === "panel" ? "while the panel is open" : "only when asked"}, written by ${settings.effective.view.writer}. This machine's own choice below applies if it leaves that relay.` : "";
  elements.settingsSummaryRelay.hidden = !settings.relayServing;
  elements.settingsSummaryRelayApply.checked = Boolean(settings.relayServing?.policy);
  const admin = isNodeAdmin();
  for (const control of [elements.settingsSummaryUpdates, elements.settingsSummaryHarness, elements.settingsSummaryModel, elements.settingsSummaryThinking, elements.settingsSummaryRelayApply]) control.disabled = !admin;
}

elements.settingsSummaryUpdates.addEventListener("change", saveSummaryPolicy);
elements.settingsSummaryHarness.addEventListener("change", () => {
  const harness = chosenHarness();
  showModelPickers(Boolean(harness));
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
