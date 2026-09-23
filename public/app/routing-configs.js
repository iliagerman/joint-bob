import { api } from "./api.js";
import { elements } from "./elements.js";
import { confirmAction, toast } from "./shell.js";

/** Named routing configurations under Settings → Classifiers. Every routing control
    lives here: the per-node active selection, the classifier timing, the confidence
    threshold, and each harness's model mappings. Sharing distributes a configuration
    to the eligible nodes of this node's clusters without touching their selection. */
let routingState = null;
let editingId = null;

function routingModelValue(provider, modelId) { return `${provider}\u0000${modelId}`; }

function configById(id) { return routingState?.configs.find((config) => config.id === id) ?? null; }

function ownerLabel(config) {
  if (config.mine) return "local";
  return config.ownerLabel || `node ${String(config.ownerNodeId).slice(0, 8)}`;
}

function harnessGridHarnesses(policy) {
  // Every harness the editor can configure: the ones this node discovered, plus any the
  // saved policy already maps so an undetected harness's mappings survive a save.
  const discovered = routingState?.harnesses ?? [];
  const known = new Set(discovered.map((harness) => harness.id));
  const extra = Object.keys(policy?.harnesses ?? {})
    .filter((id) => !known.has(id))
    .map((id) => ({ id, label: id, thinkingLevels: [], models: [], notDetected: true }));
  return [...discovered, ...extra];
}

/** Each harness gets one level grid inside the editor; the saved policy fills them. */
function renderHarnessTables(levels, policy) {
  elements.routingConfigHarnessGrids.replaceChildren();
  for (const harness of harnessGridHarnesses(policy)) {
    const fieldset = document.createElement("fieldset");
    fieldset.className = "phase-settings routing-harness";
    fieldset.dataset.routingHarness = harness.id;
    const legend = document.createElement("legend");
    legend.textContent = `${harness.label} model options`;
    const hint = document.createElement("p");
    hint.className = "settings-hint";
    hint.textContent = harness.notDetected
      ? "This harness is configured in the saved policy but is not detected on this node. Saved model options are preserved; clearing one removes it."
      : "Each level maps to one model option with its reasoning level and a required description of the requests it should handle. The classifier chooses only among the described options.";
    fieldset.append(legend, hint);
    for (let level = 1; level <= levels; level += 1) {
      const row = document.createElement("label");
      row.className = "routing-level-row";
      row.dataset.testid = `routing-level-${harness.id}-${level}`;
      const levelLabel = document.createElement("span");
      levelLabel.textContent = `Level ${level}`;
      const model = document.createElement("select");
      model.className = "routing-model";
      model.dataset.harness = harness.id;
      model.dataset.level = String(level);
      model.dataset.testid = `routing-model-${harness.id}-${level}`;
      model.add(new Option("Conversation default", ""));
      for (const entry of harness.models) model.add(new Option(`${entry.providerLabel || entry.provider} / ${entry.label || entry.id}`, routingModelValue(entry.provider, entry.id)));
      const thinking = document.createElement("select");
      thinking.className = "routing-thinking";
      thinking.dataset.harness = harness.id;
      thinking.dataset.level = String(level);
      thinking.dataset.testid = `routing-thinking-${harness.id}-${level}`;
      for (const thinkingLevel of harness.thinkingLevels) thinking.add(new Option(thinkingLevel, thinkingLevel));
      if (!harness.thinkingLevels.length) thinking.add(new Option("default", "default"));
      const description = document.createElement("input");
      description.className = "routing-description";
      description.dataset.harness = harness.id;
      description.dataset.level = String(level);
      description.dataset.testid = `routing-description-${harness.id}-${level}`;
      description.maxLength = 1000;
      description.placeholder = "Required: describe requests for this option";
      description.setAttribute("aria-label", `Level ${level} classifier description`);
      const mapping = policy?.harnesses[harness.id]?.levels[String(level)];
      if (mapping) {
        // A saved mapping whose model is not offered right now (runtime not ready, model
        // retired, harness undetected) keeps its own option, so saving cannot silently
        // clear it — shared read-only copies show the real model the same way.
        const value = routingModelValue(mapping.provider || harness.fixedProvider, mapping.modelId);
        if (![...model.options].some((option) => option.value === value)) {
          model.add(new Option(`${mapping.provider || harness.fixedProvider || "model"} / ${mapping.modelId} (saved, unavailable here)`, value));
        }
        model.value = value;
        if (![...thinking.options].some((option) => option.value === mapping.thinkingLevel)) thinking.add(new Option(mapping.thinkingLevel, mapping.thinkingLevel));
        thinking.value = mapping.thinkingLevel;
        description.value = mapping.description;
      }
      const syncDescription = () => { description.disabled = !model.value; description.required = Boolean(model.value); };
      model.addEventListener("change", syncDescription);
      syncDescription();
      row.append(levelLabel, model, thinking, description);
      fieldset.append(row);
    }
    elements.routingConfigHarnessGrids.append(fieldset);
  }
}

function editorControls() {
  return [elements.routingConfigEditorNameInput, elements.routingEnabled, elements.routingClassifier, elements.routingCadence, elements.routingCadenceN, elements.routingContextMessages, elements.routingConfidence, elements.routingConfigSaveButton, elements.routingConfigShareButton, elements.routingConfigDeleteButton,
    ...document.querySelectorAll("#routingConfigHarnessGrids [data-routing-harness] select, #routingConfigHarnessGrids [data-routing-harness] input")];
}

let editorDirty = false;

function markEditorDirty() { editorDirty = true; }

function fillEditor(config) {
  editingId = config?.id ?? null;
  editorDirty = false;
  elements.routingConfigEditor.hidden = !config;
  if (!config) return;
  // An untouched configuration prefills the default model and reasoning pairs for every harness.
  const policy = config.policy?.harnesses ? config.policy : routingState?.defaultPolicy ?? null;
  elements.routingConfigEditorLegend.textContent = `Configuration: ${config.name}`;
  elements.routingConfigEditorNameInput.value = config.name;
  elements.routingEnabled.checked = policy?.enabled !== false;
  elements.routingClassifier.replaceChildren();
  for (const classifier of routingState.classifiers) elements.routingClassifier.add(new Option(classifier.label, classifier.id));
  if (!routingState.classifiers.some((classifier) => classifier.id === policy?.classifierId) && policy?.classifierId) {
    elements.routingClassifier.add(new Option(`${policy.classifierId} (not installed)`, policy.classifierId));
  }
  elements.routingClassifier.value = policy?.classifierId || routingState.classifiers[0]?.id || "";
  elements.routingCadence.value = policy?.evalCadence?.mode || "first-message";
  elements.routingCadenceN.value = policy?.evalCadence?.n || 5;
  elements.routingContextMessages.value = policy?.contextMessages || 10;
  elements.routingConfidence.value = policy?.confidenceThreshold ?? 0.3;
  renderHarnessTables(routingState.routingLevels, policy);
  const editable = config.mine;
  for (const control of editorControls()) control.disabled = !editable;
  elements.routingConfigDeleteButton.disabled = !editable;
  elements.routingConfigShareButton.disabled = !editable;
  elements.routingConfigStatus.textContent = config.warning
    ? config.warning
    : editable
      ? config.shared ? "Shared with this node's clusters. Owned here; edits redistribute to eligible nodes." : "Local to this node. Share it to distribute it to the eligible nodes of your clusters."
      : `Shared by ${ownerLabel(config)}. Only the originating node can change or delete it.`;
}

function renderConfigList() {
  elements.routingConfigList.replaceChildren();
  if (!routingState.configs.length) {
    const empty = document.createElement("p");
    empty.className = "github-group-empty";
    empty.textContent = "No routing configurations yet. Create one below.";
    elements.routingConfigList.append(empty);
    return;
  }
  for (const config of routingState.configs) {
    const row = document.createElement("div");
    row.className = "cluster-node";
    row.dataset.testid = "routing-config-row";
    row.dataset.configId = config.id;
    const identity = document.createElement("div");
    identity.className = "cluster-node-identity";
    const name = document.createElement("strong");
    name.textContent = config.name;
    const detail = document.createElement("span");
    detail.className = "cluster-node-url";
    detail.textContent = config.shared ? `shared by ${ownerLabel(config)}` : "local";
    if (config.id === routingState.selectedId) detail.textContent += " · active";
    identity.append(name, detail);
    const edit = document.createElement("button");
    edit.className = "ghost compact";
    edit.type = "button";
    edit.dataset.testid = "routing-config-edit-button";
    edit.textContent = editingId === config.id ? "Editing" : "Edit";
    edit.addEventListener("click", () => fillEditor(config));
    row.append(identity, edit);
    elements.routingConfigList.append(row);
  }
}

function renderActiveSelect() {
  elements.routingActiveConfigSelect.replaceChildren();
  elements.routingActiveConfigSelect.add(new Option("None — keep each conversation's model", ""));
  for (const config of routingState.configs) {
    elements.routingActiveConfigSelect.add(new Option(`${config.name}${config.mine ? "" : ` (shared by ${ownerLabel(config)})`}`, config.id));
  }
  elements.routingActiveConfigSelect.value = routingState.selectedId;
}

export async function loadRoutingConfigs(preferredEditId = editingId) {
  const routing = await api("/api/routing-configs");
  routingState = routing;
  renderActiveSelect();
  renderConfigList();
  fillEditor(configById(preferredEditId));
}

function editorFormValue() {
  const cadenceMode = elements.routingCadence.value;
  const harnesses = {};
  for (const container of document.querySelectorAll("#routingConfigHarnessGrids [data-routing-harness]")) {
    const harnessId = container.dataset.routingHarness;
    const levels = {};
    for (let level = 1; level <= (routingState?.routingLevels ?? 10); level += 1) {
      const modelSelect = container.querySelector(`select.routing-model[data-level="${level}"]`);
      if (!modelSelect) continue;
      if (!modelSelect.value) { levels[String(level)] = null; continue; }
      const thinkingSelect = container.querySelector(`select.routing-thinking[data-level="${level}"]`);
      const descriptionInput = container.querySelector(`input.routing-description[data-level="${level}"]`);
      const description = descriptionInput.value.trim();
      if (!description) { descriptionInput.focus(); throw new Error(`Level ${level} needs a classifier description`); }
      const [provider, modelId] = modelSelect.value.split("\u0000");
      const fixed = routingState?.harnesses.find((harness) => harness.id === harnessId)?.fixedProvider;
      levels[String(level)] = { ...(fixed ? {} : { provider }), modelId, thinkingLevel: thinkingSelect.value, description };
    }
    harnesses[harnessId] = { levels };
  }
  return {
    enabled: elements.routingEnabled.checked,
    classifierId: elements.routingClassifier.value,
    evalCadence: { mode: cadenceMode, ...(cadenceMode === "every-n" ? { n: Number(elements.routingCadenceN.value) } : {}) },
    contextMessages: Number(elements.routingContextMessages.value),
    confidenceThreshold: Number(elements.routingConfidence.value),
    harnesses,
  };
}

async function createConfig() {
  const name = elements.routingConfigNameInput.value.trim();
  if (!name) throw new Error("Configuration name is required");
  if (!routingState?.defaultPolicy) throw new Error("Routing defaults are unavailable");
  const result = await api("/api/routing-configs", { method: "POST", body: JSON.stringify({ name, policy: routingState.defaultPolicy }) });
  elements.routingConfigNameInput.value = "";
  await loadRoutingConfigs(result.config.id);
  toast("Routing configuration created");
}

async function saveConfig(notify = true) {
  if (!editingId) throw new Error("Select a configuration first");
  const body = { name: elements.routingConfigEditorNameInput.value.trim(), policy: editorFormValue() };
  const result = await api(`/api/routing-configs/${editingId}`, { method: "PUT", body: JSON.stringify(body) });
  editorDirty = false;
  const failed = (result.results ?? []).filter((entry) => !entry.delivered);
  await loadRoutingConfigs(result.config.id);
  if (notify) toast(failed.length ? `Saved; sharing to ${failed[0].name} failed: ${failed[0].error}` : result.results?.length ? "Saved and redistributed to eligible nodes" : "Routing configuration saved");
}

/** The dialog-wide Save action commits classifier edits before closing Settings. */
export async function saveDirtyRoutingConfig() {
  if (editorDirty) await saveConfig(false);
}

async function shareConfig() {
  if (!editingId) throw new Error("Select a configuration first");
  // Sharing distributes the saved configuration, so unsaved edits are saved first —
  // anything else would quietly share stale content.
  if (editorDirty && !await confirmAction({ eyebrow: "Routing configurations", title: "Save before sharing?", message: "The editor has unsaved changes. Save them now and share the saved configuration?", confirmLabel: "Save and share" })) return;
  if (editorDirty) await saveConfig();
  const result = await api(`/api/routing-configs/${editingId}/share`, { method: "POST", body: JSON.stringify({}) });
  const { results } = result;
  await loadRoutingConfigs(editingId);
  if (!results.length) { toast("No eligible nodes to share with yet"); return; }
  const failed = results.filter((entry) => !entry.delivered);
  toast(failed.length ? `Shared with ${results.length - failed.length} of ${results.length} nodes; ${failed[0].name}: ${failed[0].error}` : `Shared with ${results.length} ${results.length === 1 ? "node" : "nodes"}`);
}

async function deleteConfig() {
  if (!editingId) throw new Error("Select a configuration first");
  const config = configById(editingId);
  if (!await confirmAction({ eyebrow: "Routing configurations", title: `Delete "${config?.name ?? "this configuration"}"?`, message: "The configuration is removed here. If it was shared, eligible nodes drop their copy. Their active selection is untouched unless it pointed at this configuration.", confirmLabel: "Delete configuration", destructive: true })) return;
  await api(`/api/routing-configs/${editingId}`, { method: "DELETE" });
  await loadRoutingConfigs(null);
  toast("Routing configuration deleted");
}

async function selectActiveConfig() {
  await api("/api/routing-configs/selection", { method: "PUT", body: JSON.stringify({ configId: elements.routingActiveConfigSelect.value }) });
  await loadRoutingConfigs();
  toast(elements.routingActiveConfigSelect.value ? "Active routing configuration updated" : "Automatic routing off");
}

function mutation(button, action) { button.addEventListener("click", () => action().catch(async (error) => { toast(error.message); try { await loadRoutingConfigs(); } catch { /* the panel refreshes on the next open */ } })); }
mutation(elements.routingConfigCreateButton, createConfig);
mutation(elements.routingConfigSaveButton, saveConfig);
mutation(elements.routingConfigShareButton, shareConfig);
mutation(elements.routingConfigDeleteButton, deleteConfig);
elements.routingActiveConfigSelect.addEventListener("change", () => { selectActiveConfig().catch((error) => toast(error.message)); });
for (const control of [elements.routingConfigEditorNameInput, elements.routingEnabled, elements.routingClassifier, elements.routingCadence, elements.routingCadenceN, elements.routingContextMessages, elements.routingConfidence]) {
  control.addEventListener("input", markEditorDirty);
  control.addEventListener("change", markEditorDirty);
}
elements.routingConfigHarnessGrids.addEventListener("input", markEditorDirty);
elements.routingConfigHarnessGrids.addEventListener("change", markEditorDirty);
