import { harnessOption } from "../harness-metadata.js";
import { api } from "./api.js";
import { createAutomationProfilePicker } from "./provider-profile-picker.js";
import { sendSocket } from "./chat-controls.js";
import { elements } from "./elements.js";
import { fillModelOptions, fillThinkingOptions, selectedModel } from "./git-reviewer-options.js";
import { toast } from "./shell.js";
import { state } from "./state.js";

let defaults = null;
const picker = { harnesses: [], models: [] };
const profilePicker = createAutomationProfilePicker(elements.autoRespondHarness.closest("label"), "auto-respond-provider-profile", () => api("/api/provider-profiles/available?usage=automation"));

const PRESETS = {
  "review-consent": {
    instructions: "Review the work done so far. Ask clarifying questions if needed. Once you understand the work and confirm it meets the requirements, respond with 'LGTM' to indicate your approval and consent.",
    stopInstructions: "The work has been reviewed and approved (LGTM received)\nAll requirements have been met\nNo further clarification is needed",
    useTools: true,
    maxResponses: null,
  },
  "aidlc-driver": {
    instructions: [
      "Drive the AI-DLC (AI Development Lifecycle) process forward. Read the project's AI-DLC configuration, understand the current phase, and guide the agent through the next steps. Use available tools to inspect code, run tests, and validate claims; the agent makes the changes.",
      "You are authorized to answer routine AI-DLC approval gates on the user's behalf, including on-demand workflow plans and stage confirmations. Review the proposal against the original request, project documentation, and available evidence. Reply with an explicit Approve when it fits, Edit with concrete changes when it needs revision, or Reject with a reason and a suitable alternative when it does not. Use the option wording requested by the agent. A workflow asking for an explicit user decision is a prompt for your reviewed reply, not by itself a reason to stop.",
      "Keep decisions within the original scope and any limits the user set. Prefer the agent's recommendation when supported by the evidence; otherwise choose the simplest option that meets the request. Ask the agent to supply missing evidence or fix problems rather than approving unchecked work. Keep replies short and give the agent a clear next step.",
    ].join("\n\n"),
    stopInstructions: [
      "The current AI-DLC phase is complete and verified, with no pending review or approval gate.",
      "Continuing needs credentials, private information, or a decision the user explicitly reserved for themselves. Routine plan approval, edits, rejection, and stage confirmations are delegated to you, even when the workflow requests an explicit user decision.",
      "Continuing requires a destructive or hard-to-undo action, production deployment, sending messages or email, or spending money. Routine workflow approval does not authorize these actions.",
      "An external dependency or failing test needs manual intervention that the agent cannot perform.",
    ].join("\n"),
    useTools: true,
    maxResponses: null,
  },
  "implementation-reviewer": {
    instructions: "Act as an ongoing, constructive reviewer of the coding agent's implementation. At each pause, inspect the changes and the agent's claims, check relevant tests and verification results, and keep reviewing until the requested feature is implemented and tested. Report only meaningful correctness gaps, risks, missed requirements, or high-value improvements; do not nitpick style or offer speculative suggestions. Give concise, specific feedback with evidence and actionable next steps. If the work is solid so far, acknowledge that and let the agent continue; do not declare completion until the feature is implemented and its relevant tests pass. This role complements the AI-DLC driver: review the work, but do not take over the lifecycle or make code changes.",
    stopInstructions: "The requested feature is implemented and relevant tests or checks pass\nA required check fails and the agent must fix it\nBlocked on a user decision, credentials, or external dependency",
    useTools: true,
    maxResponses: null,
  },
};

/** Shows the conversation's auto respond state in the toolbar pill and the menu button.
 * `decision` is the responder's decision in progress ({ startedAt, step }), or null. */
export function setAutoRespond(autoRespond, decision = null, nextDefaults) {
  if (nextDefaults) defaults = nextDefaults;
  state.autoRespond = autoRespond && autoRespond.status !== "off" ? autoRespond : null;
  state.autoRespondDecision = decision;
  const current = state.autoRespond;
  const pill = elements.autoRespondPill;
  pill.hidden = !current;
  if (current) {
    pill.dataset.state = current.status;
    const count = `${current.responses}${current.maxResponses ? `/${current.maxResponses}` : ""}`;
    pill.textContent = current.status === "active" ? (decision ? `Auto … ${count}` : `Auto ${count}`) : "Auto stopped";
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

// Opens at once: listing harnesses and models can take seconds, and a dialog that
// appeared only afterwards popped up behind whatever the user had moved on to.
async function openAutoRespond() {
  elements.chatMoreMenu.open = false;
  const saved = state.autoRespond;

  // Detect if current config matches a preset
  let matchingPreset = "";
  if (saved) {
    for (const [presetId, preset] of Object.entries(PRESETS)) {
      if (saved.instructions === preset.instructions && saved.stopInstructions === preset.stopInstructions) {
        matchingPreset = presetId;
        break;
      }
    }
  }

  elements.autoRespondPreset.value = matchingPreset;
  elements.autoRespondInstructions.value = saved?.instructions ?? defaults?.instructions ?? "";
  elements.autoRespondStopInstructions.value = saved ? saved.stopInstructions : defaults?.stopInstructions ?? "";
  elements.autoRespondLimit.value = saved ? saved.maxResponses ?? "" : defaults?.maxResponses ?? "";
  elements.autoRespondUseTools.checked = saved ? saved.useTools !== false : true;
  elements.autoRespondEnabled.checked = !saved || saved.status !== "off";
  renderStatus();
  elements.autoRespondDialog.showModal();

  if (!picker.harnesses.length) {
    elements.saveAutoRespondButton.disabled = true;
    const [harnessBody, modelBody] = await Promise.all([api("/api/harnesses"), api("/api/models")]);
    picker.harnesses = harnessBody.harnesses.filter((harness) => harness.runtimeConfigured);
    picker.models = modelBody.models;
    elements.autoRespondHarness.replaceChildren(...picker.harnesses.map(harnessOption));
    elements.saveAutoRespondButton.disabled = false;
  }
  const savedPick = saved ? { harnessId: saved.harnessId, provider: saved.provider, modelId: saved.modelId, thinkingLevel: saved.thinkingLevel } : undefined;
  elements.autoRespondHarness.value = picker.harnesses.some((harness) => harness.id === (saved?.harnessId ?? state.engine)) ? (saved?.harnessId ?? state.engine) : picker.harnesses[0]?.id ?? "";
  fillPickers(savedPick);
  elements.saveAutoRespondButton.disabled = true;
  try { await profilePicker.refresh(saved?.providerProfileId); }
  finally { elements.saveAutoRespondButton.disabled = false; }
}

function applyPreset() {
  const presetId = elements.autoRespondPreset.value;
  if (!presetId) return; // Custom preset, do nothing

  const preset = PRESETS[presetId];
  if (!preset) return;

  elements.autoRespondInstructions.value = preset.instructions;
  elements.autoRespondStopInstructions.value = preset.stopInstructions;
  elements.autoRespondUseTools.checked = preset.useTools;
  elements.autoRespondLimit.value = preset.maxResponses ?? "";
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
  let providerProfileId;
  try { providerProfileId = profilePicker.value(); }
  catch (error) { toast(error.message); return; }
  const config = {
    providerProfileId,
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

for (const button of [elements.autoRespondButton, elements.autoRespondPill]) {
  button.addEventListener("click", () => void openAutoRespond().catch((error) => toast(error.message)));
}
elements.cancelAutoRespondButton.addEventListener("click", () => elements.autoRespondDialog.close());
elements.autoRespondForm.addEventListener("submit", save);
elements.autoRespondHarness.addEventListener("change", () => fillPickers());
elements.autoRespondModel.addEventListener("change", () => {
  const harness = pickedHarness();
  if (harness) fillThinkingOptions(harness, picker.models, elements.autoRespondModel, elements.autoRespondThinking, elements.autoRespondThinking.value);
});
elements.autoRespondPreset.addEventListener("change", applyPreset);

// Reset to custom preset when instructions are manually changed
function markAsCustomPreset() {
  const currentPreset = elements.autoRespondPreset.value;
  if (!currentPreset) return; // Already custom

  const preset = PRESETS[currentPreset];
  if (!preset) return;

  // Check if values still match the preset
  const matchesPreset = elements.autoRespondInstructions.value === preset.instructions
    && elements.autoRespondStopInstructions.value === preset.stopInstructions;

  if (!matchesPreset) {
    elements.autoRespondPreset.value = "";
  }
}

elements.autoRespondInstructions.addEventListener("input", markAsCustomPreset);
elements.autoRespondStopInstructions.addEventListener("input", markAsCustomPreset);
