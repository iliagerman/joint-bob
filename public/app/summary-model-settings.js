import { harnessOption } from "../harness-metadata.js";
import { api, savePreferences } from "./api.js";
import { elements } from "./elements.js";
import { fillModelOptions, fillThinkingOptions, selectedModel } from "./git-reviewer-options.js";
import { state } from "./state.js";
import { toast } from "./shell.js";

// Settings → Conversations → Activity summary: which agent and model write the
// running summary. Empty means the conversation's own, chosen per summary.

const choices = { harnesses: [], models: [] };

function chosenHarness() {
  return choices.harnesses.find((harness) => harness.id === elements.settingsSummaryHarness.value);
}

function showModelPickers(visible) {
  elements.settingsSummaryModelLabel.hidden = !visible;
  elements.settingsSummaryThinkingLabel.hidden = !visible;
}

function saveSummaryModel() {
  const harness = chosenHarness();
  const { provider, modelId } = selectedModel(elements.settingsSummaryModel);
  const summaryModel = harness ? { harnessId: harness.id, ...(provider ? { provider } : {}), modelId, thinkingLevel: elements.settingsSummaryThinking.value } : null;
  state.summaryModel = summaryModel;
  savePreferences({ summaryModel }).catch((error) => toast(error.message));
  document.dispatchEvent(new CustomEvent("summary-model-changed"));
}

export async function loadSummaryModelSettings() {
  const [harnessBody, modelBody] = await Promise.all([api("/api/harnesses"), api("/api/models")]);
  choices.harnesses = harnessBody.harnesses.filter((harness) => harness.runtimeConfigured);
  choices.models = modelBody.models;
  elements.settingsSummaryHarness.replaceChildren(new Option("Same as conversation", ""), ...choices.harnesses.map(harnessOption));
  const saved = state.summaryModel;
  elements.settingsSummaryHarness.value = saved && choices.harnesses.some((harness) => harness.id === saved.harnessId) ? saved.harnessId : "";
  const harness = chosenHarness();
  showModelPickers(Boolean(harness));
  if (harness) fillModelOptions(harness, choices.models, elements.settingsSummaryModel, elements.settingsSummaryThinking, saved);
}

elements.settingsSummaryHarness.addEventListener("change", () => {
  const harness = chosenHarness();
  showModelPickers(Boolean(harness));
  if (harness) fillModelOptions(harness, choices.models, elements.settingsSummaryModel, elements.settingsSummaryThinking);
  saveSummaryModel();
});
elements.settingsSummaryModel.addEventListener("change", () => {
  fillThinkingOptions(chosenHarness(), choices.models, elements.settingsSummaryModel, elements.settingsSummaryThinking, elements.settingsSummaryThinking.value);
  saveSummaryModel();
});
elements.settingsSummaryThinking.addEventListener("change", saveSummaryModel);
