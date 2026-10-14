import { harnessOption } from "../harness-metadata.js";
import { api } from "./api.js";
import { sendSocket } from "./chat-controls.js";
import { elements } from "./elements.js";
import { fillModelOptions, fillThinkingOptions, selectedModel } from "./git-reviewer-options.js";
import { toast } from "./shell.js";
import { state } from "./state.js";

let defaults = null;
let phase = "idle";
const picker = { harnesses: [], models: [] };

/** Shows the conversation's auto respond state in the toolbar pill and the menu button. */
export function setAutoRespond(autoRespond, nextPhase = "idle", nextDefaults) {
  if (nextDefaults) defaults = nextDefaults;
  state.autoRespond = autoRespond && autoRespond.status !== "off" ? autoRespond : null;
  phase = nextPhase;
  const current = state.autoRespond;
  const pill = elements.autoRespondPill;
  pill.hidden = !current;
  if (current) {
    pill.dataset.state = current.status;
    const count = `${current.responses}${current.maxResponses ? `/${current.maxResponses}` : ""}`;
    pill.textContent = current.status === "active" ? (phase === "deciding" ? `Auto … ${count}` : `Auto ${count}`) : "Auto stopped";
    pill.title = current.status === "stopped" ? current.stopReason || "Stopped" : "Auto respond is answering for you";
  }
  elements.autoRespondButton.classList.toggle("active", current?.status === "active");
  if (elements.autoRespondDialog.open) renderStatus();
}

/** Marks a message the responder wrote rather than a person. */
export function markAutoReply(bubble, auto) {
  bubble.classList.add("auto-reply");
  const badge = document.createElement("span");
  badge.className = "auto-badge";
  badge.textContent = "Auto";
  badge.title = auto.reason ? `Written by ${auto.modelId}: ${auto.reason}` : `Written by ${auto.modelId}`;
  bubble.prepend(badge);
}

function renderStatus() {
  const current = state.autoRespond;
  elements.autoRespondStatus.textContent = !current ? "Off."
    : current.status === "active" ? `On. ${current.responses}${current.maxResponses ? ` of ${current.maxResponses}` : ""} responses so far.`
      : `Stopped: ${current.stopReason || "stopped"}. Saving with the box ticked resumes it from zero.`;
  elements.saveAutoRespondButton.textContent = current?.status === "stopped" ? "Save and resume" : "Save";
}

function pickedHarness() {
  return picker.harnesses.find((harness) => harness.id === elements.autoRespondHarness.value);
}

function fillPickers(saved) {
  const harness = pickedHarness();
  if (harness) fillModelOptions(harness, picker.models, elements.autoRespondModel, elements.autoRespondThinking, saved && saved.harnessId === harness.id ? saved : undefined);
}

async function openAutoRespond() {
  elements.chatMoreMenu.open = false;
  if (!picker.harnesses.length) {
    const [harnessBody, modelBody] = await Promise.all([api("/api/harnesses"), api("/api/models")]);
    picker.harnesses = harnessBody.harnesses.filter((harness) => harness.runtimeConfigured);
    picker.models = modelBody.models;
    elements.autoRespondHarness.replaceChildren(...picker.harnesses.map(harnessOption));
  }
  const saved = state.autoRespond;
  const savedPick = saved ? { harnessId: saved.harnessId, provider: saved.provider, modelId: saved.modelId, thinkingLevel: saved.thinkingLevel } : undefined;
  elements.autoRespondHarness.value = picker.harnesses.some((harness) => harness.id === (saved?.harnessId ?? state.engine)) ? (saved?.harnessId ?? state.engine) : picker.harnesses[0]?.id ?? "";
  fillPickers(savedPick);
  elements.autoRespondInstructions.value = saved?.instructions ?? defaults?.instructions ?? "";
  elements.autoRespondStopInstructions.value = saved ? saved.stopInstructions : defaults?.stopInstructions ?? "";
  elements.autoRespondLimit.value = saved ? saved.maxResponses ?? "" : defaults?.maxResponses ?? "";
  elements.autoRespondUseTools.checked = saved ? saved.useTools !== false : true;
  elements.autoRespondEnabled.checked = !saved || saved.status !== "off";
  renderStatus();
  elements.autoRespondDialog.showModal();
}

function save(event) {
  event.preventDefault();
  if (!elements.autoRespondEnabled.checked) {
    if (sendSocket({ type: "autoRespond", autoRespond: { enabled: false } })) elements.autoRespondDialog.close();
    else toast("Not connected");
    return;
  }
  const harness = pickedHarness();
  if (!harness) { toast("Choose a harness"); return; }
  const { provider, modelId } = selectedModel(elements.autoRespondModel);
  const limit = elements.autoRespondLimit.value.trim();
  const config = {
    harnessId: harness.id,
    provider: provider || harness.configuration?.fixedProvider || harness.defaults.provider,
    modelId,
    thinkingLevel: elements.autoRespondThinking.value,
    instructions: elements.autoRespondInstructions.value.trim(),
    stopInstructions: elements.autoRespondStopInstructions.value.trim(),
    maxResponses: limit ? Number(limit) : null,
    useTools: elements.autoRespondUseTools.checked,
  };
  if (!config.instructions) { toast("Write the instructions for the responder"); return; }
  if (sendSocket({ type: "autoRespond", autoRespond: { enabled: true, config } })) elements.autoRespondDialog.close();
  else toast("Not connected");
}

elements.autoRespondButton.addEventListener("click", () => void openAutoRespond().catch((error) => toast(error.message)));
elements.cancelAutoRespondButton.addEventListener("click", () => elements.autoRespondDialog.close());
elements.autoRespondForm.addEventListener("submit", save);
elements.autoRespondHarness.addEventListener("change", () => fillPickers());
elements.autoRespondModel.addEventListener("change", () => {
  const harness = pickedHarness();
  if (harness) fillThinkingOptions(harness, picker.models, elements.autoRespondModel, elements.autoRespondThinking, elements.autoRespondThinking.value);
});
