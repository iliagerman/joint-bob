import { harnessOption } from "../harness-metadata.js";
import { api } from "./api.js";
import { fillModelOptions, selectedModel } from "./git-reviewer-options.js";
import { state } from "./state.js";
import { toast } from "./shell.js";

/**
 * Settings → Labels: one row per label line in the textarea, each with an icon the user
 * can type, leave empty (the label then shows as text), or ask an agent to pick.
 */
const labelsField = document.querySelector("#settingsConversationLabels");
const rows = document.querySelector("#settingsLabelIcons");
const harnessSelect = document.querySelector("#settingsLabelIconHarness");
const modelSelect = document.querySelector("#settingsLabelIconModel");
const modelLabel = document.querySelector("#settingsLabelIconModelLabel");
const effortSelect = document.createElement("select");
let runnableHarnesses = [];
let models = [];
let draft = {};

const labelNames = () => [...new Set(labelsField.value.split("\n").map((label) => label.trim()).filter(Boolean))];

function pickedHarness() {
  return runnableHarnesses.find((harness) => harness.id === harnessSelect.value);
}

function renderModels() {
  const harness = pickedHarness();
  modelLabel.hidden = !harness;
  if (harness) fillModelOptions(harness, models, modelSelect, effortSelect);
}

async function renderHarnessOptions() {
  const chosen = harnessSelect.value;
  if (!models.length) {
    try {
      const [harnessBody, modelBody] = await Promise.all([api("/api/harnesses"), api("/api/models")]);
      runnableHarnesses = harnessBody.harnesses.filter((harness) => harness.runtimeConfigured && harness.ready);
      models = modelBody.models;
    } catch (error) {
      toast(error.message);
    }
  }
  harnessSelect.replaceChildren(new Option("Automatic (default agent)", ""), ...runnableHarnesses.map(harnessOption));
  harnessSelect.value = runnableHarnesses.some((harness) => harness.id === chosen) ? chosen : "";
  renderModels();
}

harnessSelect.addEventListener("change", renderModels);

function pickedModel() {
  const { provider, modelId } = selectedModel(modelSelect);
  return { ...(provider ? { provider } : {}), ...(modelId ? { modelId } : {}) };
}

function row(label) {
  const item = document.createElement("div");
  item.className = "label-icon-row";
  item.dataset.testid = "label-icon-row";
  const name = document.createElement("span");
  name.className = "label-icon-name";
  name.textContent = label;
  const input = document.createElement("input");
  input.className = "label-icon-input";
  input.maxLength = 16;
  input.autocomplete = "off";
  input.placeholder = "None";
  input.value = draft[label] || "";
  input.dataset.testid = "label-icon-input";
  input.setAttribute("aria-label", `Icon for ${label}`);
  input.addEventListener("input", () => { draft[label] = input.value.trim(); });
  const generate = document.createElement("button");
  generate.type = "button";
  generate.className = "ghost";
  generate.textContent = "Generate";
  generate.dataset.testid = "label-icon-generate";
  generate.setAttribute("aria-label", `Generate an icon for ${label}`);
  generate.addEventListener("click", async () => {
    generate.disabled = true;
    generate.textContent = "Generating…";
    try {
      const body = await api("/api/settings/label-icon", { method: "POST", body: JSON.stringify({ label, ...(harnessSelect.value ? { harnessId: harnessSelect.value, ...pickedModel() } : {}) }) });
      draft[label] = body.icon;
      input.value = body.icon;
    } catch (error) {
      toast(error.message, 8000);
    } finally {
      generate.disabled = false;
      generate.textContent = "Generate";
    }
  });
  item.append(name, input, generate);
  return item;
}

function render() {
  void renderHarnessOptions();
  const names = labelNames();
  rows.replaceChildren(...names.map(row));
}

labelsField.addEventListener("change", render);
labelsField.addEventListener("blur", render);

export function loadLabelIcons(icons) {
  draft = { ...icons };
  render();
}

/** Icons for the labels now in the textarea; a blank icon means the label shows as text. */
export function labelIconsValue() {
  return Object.fromEntries(labelNames().filter((label) => draft[label]).map((label) => [label, draft[label]]));
}
