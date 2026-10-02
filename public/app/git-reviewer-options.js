import { harnessOption } from "../harness-metadata.js";
import { api, savePreferences } from "./api.js";
import { elements } from "./elements.js";
import { state } from "./state.js";
import { toast } from "./shell.js";

const DEFAULT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const PREFERRED_MODEL = { pi: "gpt-6-sol", claude: "opus" };

/** Fills the effort picker for the chosen model, keeping `preferred` when that level exists. */
export function fillThinkingOptions(harness, models, modelSelect, thinkingSelect, preferred) {
  const model = models.find((item) => item.harnessId === harness.id && item.id === modelSelect.value);
  const levels = model?.thinkingLevels ?? harness.configuration?.thinkingLevels ?? DEFAULT_LEVELS;
  thinkingSelect.replaceChildren(...levels.map((level) => new Option(level, level)));
  thinkingSelect.value = [preferred, "xhigh", harness.defaults.thinkingLevel].find((level) => level && levels.includes(level)) ?? levels[0];
}

/** Fills the model and effort pickers for a harness, keeping a saved choice when it is still offered. */
export function fillModelOptions(harness, models, modelSelect, thinkingSelect, preferred = {}) {
  const harnessModels = models.filter((model) => model.harnessId === harness.id);
  modelSelect.replaceChildren(...(harnessModels.length
    ? harnessModels.map((model) => { const option = new Option(model.label, model.id); option.dataset.provider = model.provider; return option; })
    : [new Option(harness.defaults.modelId, harness.defaults.modelId)]));
  const modelId = [preferred.modelId, PREFERRED_MODEL[harness.id] ?? harness.defaults.modelId].find((id) => [...modelSelect.options].some((option) => option.value === id));
  if (modelId) modelSelect.value = modelId;
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
  const gitReviewer = harness ? { harnessId: harness.id, modelId: elements.settingsGitReviewerModel.value, thinkingLevel: elements.settingsGitReviewerThinking.value } : null;
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
