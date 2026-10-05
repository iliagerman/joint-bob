import { harnessOption } from "../harness-metadata.js";
import { api, savePreferences } from "./api.js";
import { elements } from "./elements.js";
import { state } from "./state.js";
import { toast } from "./shell.js";

const DEFAULT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const PREFERRED_MODEL = { pi: "gpt-6-sol", claude: "opus" };
const DEFAULT_LEVEL = "medium";

/** The provider and model behind the picked option; values are provider-qualified so equal IDs stay apart. */
export function selectedModel(modelSelect) {
  const option = modelSelect.selectedOptions[0];
  return { provider: option?.dataset.provider || "", modelId: option?.dataset.modelId || modelSelect.value };
}

/** Selects `modelId`, preferring the option from `provider` when one is given. Returns false when it is not offered. */
export function selectModel(modelSelect, modelId, provider) {
  const options = [...modelSelect.options].filter((option) => option.dataset.modelId === modelId);
  const option = options.find((candidate) => provider && candidate.dataset.provider === provider) ?? options[0];
  if (option) modelSelect.value = option.value;
  return Boolean(option);
}

function modelOption(label, modelId, provider = "") {
  const option = new Option(label, `${provider}|${modelId}`);
  option.dataset.modelId = modelId;
  if (provider) option.dataset.provider = provider;
  return option;
}

/** Fills the effort picker for the chosen model, keeping `preferred` when that level exists. */
export function fillThinkingOptions(harness, models, modelSelect, thinkingSelect, preferred) {
  const picked = selectedModel(modelSelect);
  const model = models.find((item) => item.harnessId === harness.id && item.id === picked.modelId && (!picked.provider || item.provider === picked.provider));
  const levels = model?.thinkingLevels ?? harness.configuration?.thinkingLevels ?? DEFAULT_LEVELS;
  thinkingSelect.replaceChildren(...levels.map((level) => new Option(level, level)));
  thinkingSelect.value = [preferred, DEFAULT_LEVEL, harness.defaults.thinkingLevel].find((level) => level && levels.includes(level)) ?? levels[0];
}

/** Fills the model and effort pickers for a harness, grouped by provider, keeping a saved choice when it is still offered. */
export function fillModelOptions(harness, models, modelSelect, thinkingSelect, preferred = {}) {
  const harnessModels = models.filter((model) => model.harnessId === harness.id);
  const providers = [...new Set(harnessModels.map((model) => model.provider))];
  const optionsFor = (provider) => harnessModels.filter((model) => model.provider === provider).map((model) => modelOption(model.label, model.id, model.provider));
  modelSelect.replaceChildren(...(!harnessModels.length
    ? [modelOption(harness.defaults.modelId, harness.defaults.modelId)]
    : providers.length === 1 ? optionsFor(providers[0])
      : providers.map((provider) => {
        const group = document.createElement("optgroup");
        const label = harnessModels.find((model) => model.provider === provider)?.providerLabel;
        group.label = label ? `${label} (${provider})` : provider;
        group.append(...optionsFor(provider));
        return group;
      })));
  if (!(preferred.modelId && selectModel(modelSelect, preferred.modelId, preferred.provider))) selectModel(modelSelect, PREFERRED_MODEL[harness.id] ?? harness.defaults.modelId);
  fillThinkingOptions(harness, models, modelSelect, thinkingSelect, preferred.thinkingLevel);
}

const settings = { harnesses: [], models: [] };

function settingsHarness() {
  return settings.harnesses.find((harness) => harness.id === elements.settingsGitReviewerHarness.value);
}

function showSettingsModelPickers(visible) {
  elements.settingsGitReviewerModelLabel.hidden = !visible;
  elements.settingsGitReviewerThinkingLabel.hidden = !visible;
}

function saveSettingsReviewer() {
  const harness = settingsHarness();
  const { provider, modelId } = selectedModel(elements.settingsGitReviewerModel);
  const gitReviewer = harness ? { harnessId: harness.id, ...(provider ? { provider } : {}), modelId, thinkingLevel: elements.settingsGitReviewerThinking.value } : null;
  state.gitReviewer = gitReviewer;
  savePreferences({ gitReviewer }).catch((error) => toast(error.message));
}

/** Loads the Settings → Git panel from the saved default reviewer. */
export async function loadGitReviewerSettings() {
  const [harnessBody, modelBody] = await Promise.all([api("/api/harnesses"), api("/api/models")]);
  settings.harnesses = harnessBody.harnesses.filter((harness) => harness.runtimeConfigured);
  settings.models = modelBody.models;
  elements.settingsGitReviewerHarness.replaceChildren(new Option("Automatic (from conversation)", ""), ...settings.harnesses.map(harnessOption));
  const saved = state.gitReviewer;
  elements.settingsGitReviewerHarness.value = saved && settings.harnesses.some((harness) => harness.id === saved.harnessId) ? saved.harnessId : "";
  const harness = settingsHarness();
  showSettingsModelPickers(Boolean(harness));
  if (harness) fillModelOptions(harness, settings.models, elements.settingsGitReviewerModel, elements.settingsGitReviewerThinking, saved);
}

elements.settingsGitReviewerHarness.addEventListener("change", () => {
  const harness = settingsHarness();
  showSettingsModelPickers(Boolean(harness));
  if (harness) fillModelOptions(harness, settings.models, elements.settingsGitReviewerModel, elements.settingsGitReviewerThinking);
  saveSettingsReviewer();
});
elements.settingsGitReviewerModel.addEventListener("change", () => {
  fillThinkingOptions(settingsHarness(), settings.models, elements.settingsGitReviewerModel, elements.settingsGitReviewerThinking, elements.settingsGitReviewerThinking.value);
  saveSettingsReviewer();
});
elements.settingsGitReviewerThinking.addEventListener("change", saveSettingsReviewer);
