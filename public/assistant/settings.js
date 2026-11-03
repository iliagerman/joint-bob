import { harnessOption } from "../harness-metadata.js";
import { put, request } from "./api.js";
import { app, fail, navigate, notify } from "./context.js";
import { h, switchButton } from "./dom.js";

// Settings: instructions, decision model, execution, terminal, default assistant and listing.

let harnesses = [];
let models = [];
let loadedFor = null;

const sourceLink = () => {
  const target = new URL("/", location.origin);
  target.searchParams.set("projectId", app.assistant.projectId);
  target.searchParams.set("sessionId", app.assistant.sessionId);
  if (app.assistant.nodeId) target.searchParams.set("nodeId", app.assistant.nodeId);
  return target;
};

/** The assistant PUT needs the whole profile; optional fields are sent only when they change. */
export async function saveAssistant(changes = {}) {
  const current = app.assistant;
  const { assistant } = await put(`/api/personal-assistants/${current.id}`, {
    projectId: current.projectId, engine: current.engine, sessionId: current.sessionId, name: current.name, instructions: current.instructions,
    classifierId: current.classifierId, allowBrowser: current.allowBrowser, allowTerminal: current.allowTerminal, ...changes,
  });
  app.assistant = assistant;
  app.assistants = app.assistants.map(entry => entry.id === assistant.id ? assistant : entry);
  return assistant;
}

export function fillSettings() {
  const entry = app.assistant;
  document.querySelector("#name").value = entry.name;
  document.querySelector("#instructions").value = entry.instructions;
  document.querySelector("#allow-terminal").checked = entry.allowTerminal;
  document.querySelector("#classifier").value = entry.classifierId || "typesafe";
  document.querySelector("#chat").href = sourceLink();
  if (loadedFor !== entry.id) loadedFor = null;
}

export async function showSettings() {
  await Promise.all([showExecution(), showDefaultAndDiscovery()]);
}

async function showExecution() {
  if (loadedFor === app.assistant.id) return;
  const save = document.querySelector("#settings button");
  save.disabled = true;
  const { harnesses: listed } = await request("/api/harnesses");
  harnesses = listed.filter(harness => harness.runtimeConfigured);
  const selector = document.querySelector("#execution-harness");
  selector.replaceChildren(new Option("Use conversation settings", ""), ...harnesses.map(harnessOption));
  const saved = app.assistant.executionSettings;
  if (saved && !harnesses.some(harness => harness.id === saved.harnessId)) {
    const unavailable = new Option(`${saved.harnessId} (unavailable here)`, saved.harnessId);
    unavailable.disabled = true;
    selector.add(unavailable);
  }
  selector.value = saved?.harnessId ?? "";
  await fillModels(saved);
  loadedFor = app.assistant.id;
  save.disabled = false;
}

async function fillModels(preferred) {
  const harness = harnesses.find(item => item.id === document.querySelector("#execution-harness").value);
  const modelSelect = document.querySelector("#execution-model");
  const effortSelect = document.querySelector("#execution-effort");
  const disable = (model, effort) => {
    models = [];
    modelSelect.replaceChildren(new Option(model, "")); effortSelect.replaceChildren(new Option(effort, ""));
    modelSelect.disabled = true; effortSelect.disabled = true;
  };
  if (!harness) { disable("Use conversation settings", "Use conversation settings"); return; }
  const { models: options } = await request(`/api/harnesses/${encodeURIComponent(harness.id)}/model-options`);
  if (!options.length) { disable("No models available", "No effort levels available"); return; }
  models = options;
  modelSelect.replaceChildren(...options.map(model => {
    const option = new Option(`${model.label} (${model.provider})`, `${model.provider}|${model.id}`);
    option.dataset.provider = model.provider; option.dataset.modelId = model.id;
    return option;
  }));
  const savedModel = preferred?.harnessId === harness.id && options.find(model => model.id === preferred.modelId && model.provider === preferred.provider);
  const defaultModel = options.find(model => model.id === harness.defaults.modelId && model.provider === harness.defaults.provider);
  const selected = savedModel || defaultModel || options[0];
  modelSelect.value = `${selected.provider}|${selected.id}`;
  modelSelect.disabled = false;
  fillEffort(preferred?.harnessId === harness.id ? preferred.reasoning : "");
}

function fillEffort(preferred = "") {
  const harness = harnesses.find(item => item.id === document.querySelector("#execution-harness").value);
  const selected = document.querySelector("#execution-model").selectedOptions[0];
  const model = models.find(item => item.id === selected?.dataset.modelId && item.provider === selected?.dataset.provider);
  const effortSelect = document.querySelector("#execution-effort");
  const levels = model?.thinkingLevels ?? [];
  effortSelect.replaceChildren(...levels.map(level => new Option(level, level)));
  if (!levels.length) { effortSelect.disabled = true; return; }
  effortSelect.value = levels.includes(preferred) ? preferred : levels.includes(harness.defaults.thinkingLevel) ? harness.defaults.thinkingLevel : levels[0];
  effortSelect.disabled = false;
}

function executionValue() {
  const harnessId = document.querySelector("#execution-harness").value;
  if (!harnessId) return null;
  const model = document.querySelector("#execution-model").selectedOptions[0];
  const reasoning = document.querySelector("#execution-effort").value;
  if (!model || !model.dataset.provider || !model.dataset.modelId || !reasoning) throw new Error("Choose an available model and effort for this agent");
  return { harnessId, provider: model.dataset.provider, modelId: model.dataset.modelId, reasoning };
}

async function submitSettings(event) {
  event.preventDefault();
  try {
    const updated = await saveAssistant({ name: document.querySelector("#name").value, instructions: document.querySelector("#instructions").value, classifierId: document.querySelector("#classifier").value, allowTerminal: document.querySelector("#allow-terminal").checked, executionSettings: executionValue() });
    loadedFor = null;
    document.querySelector("#heading").textContent = updated.name;
    notify("Settings saved");
    await navigate({ id: updated.id });
  } catch (error) { fail(error); }
}

/** This assistant's place among the owner's choices: default for groups, and where it is listed. */
async function showDefaultAndDiscovery() {
  const me = app.me;
  const defaultTarget = document.querySelector("#settings-default");
  const discoveryTarget = document.querySelector("#settings-discovery");
  if (!me) { defaultTarget.replaceChildren(); discoveryTarget.replaceChildren(); return; }
  const isDefault = me.profile.defaultAssistantId === app.assistant.id;
  defaultTarget.replaceChildren(h("h2", {}, "Default assistant"), h("p", { class: "muted" }, "Your default joins every group you join and leaves when you leave."),
    isDefault ? h("p", {}, "This is your default assistant.")
      : h("button", { type: "button", "data-testid": "assistant-make-default", onclick: () => setDefault(app.assistant.id) }, "Make this my default"));
  const listed = new Set(me.discovery.filter(item => item.subjectKind === "assistant" && item.subjectId === app.assistant.id).map(item => item.relayNodeId));
  const findable = listed.size > 0;
  discoveryTarget.replaceChildren(h("h2", {}, "Who can find this assistant"),
    h("p", { class: "muted" }, "Signed-in people on these relays can find it and see its public actions. Its listing names you as its owner."),
    me.relays.length ? h("div", {},
      h("div", { class: "sec-row" }, h("strong", {}, findable ? "Findable" : "Hidden from everyone"),
        switchButton({ checked: findable, label: `${app.assistant.name} findable`, testid: "assistant-findable-switch", onToggle: () => setFindable("assistant", app.assistant.id, !findable) })),
      findable ? me.relays.map(relay => h("div", { class: "sec-row" }, h("span", {}, relay.name, relay.active ? "" : " (not connected)"),
        switchButton({ checked: listed.has(relay.relayNodeId), label: `${app.assistant.name} findable on ${relay.name}`, onToggle: () => setDiscovery("assistant", app.assistant.id, relay.relayNodeId, !listed.has(relay.relayNodeId)) }))) : null)
      : h("p", { class: "fine" }, "This machine isn't on a relay yet. Join one in Settings → Relays to list this assistant."),
    h("button", { type: "button", class: "link", onclick: () => navigate({ screen: "you" }) }, "Open Who can find you"));
}

export async function setDefault(assistantId) {
  try {
    const { profile } = await put("/api/social/default-assistant", { assistantId });
    app.me.profile = profile;
    const name = app.assistants.find(entry => entry.id === assistantId)?.name;
    notify(name ? `${name} is your default. Groups you're already in don't change.` : "You have no default. Groups you're already in don't change.");
    if (app.assistant) await showDefaultAndDiscovery();
  } catch (error) { fail(error); }
}

/** The one switch: on every relay, or hidden from everyone. Groups and existing requests stay. */
export async function setFindable(subjectKind, subjectId, findable) {
  try {
    const { discovery } = await put("/api/social/findable", { subjectKind, subjectId, findable });
    app.me.discovery = discovery;
    notify(findable ? "Findable on your relays." : "Hidden. Nobody can find this or start a new request. Groups and existing requests stay.");
    if (app.assistant) await showDefaultAndDiscovery();
  } catch (error) { fail(error); }
}

export async function setDiscovery(subjectKind, subjectId, relayNodeId, enabled) {
  try {
    const { discovery } = await put("/api/social/discovery", { subjectKind, subjectId, relayNodeId, enabled });
    app.me.discovery = discovery;
    if (enabled && subjectKind === "assistant") notify("An assistant's listing names you as its owner, even on a relay where you aren't findable yourself.");
    if (app.assistant) await showDefaultAndDiscovery();
    return discovery;
  } catch (error) { fail(error); return app.me.discovery; }
}

export function bindSettings() {
  document.querySelector("#settings").addEventListener("submit", submitSettings);
  document.querySelector("#execution-harness").addEventListener("change", async () => {
    const save = document.querySelector("#settings button");
    save.disabled = true;
    try { await fillModels(null); } catch (error) { fail(error); } finally { save.disabled = false; }
  });
  document.querySelector("#execution-model").addEventListener("change", () => fillEffort());
  document.querySelector("#copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(`${location.origin}/assistant.html?id=${encodeURIComponent(app.assistant.id)}`); notify("Assistant link copied"); }
    catch (error) { fail(error); }
  });
}

