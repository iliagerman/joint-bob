// Settings → Activity overview: how stories are written, shown and spoken on this node.
import { api, apiBlob } from "./api.js";
import { toast } from "./shell.js";

const field = (id) => document.getElementById(id);
const inputs = {
  instructions: field("storyInstructions"), backdrops: field("storyBackdrops"), moods: field("storyMoods"), codeSlides: field("storyCodeSlides"),
  codeWriteup: field("storyCodeWriteup"), maxCodeLines: field("storyMaxCodeLines"), ask: field("storyAsk"), narrate: field("storyNarrate"),
  voiceProvider: field("storyVoiceProvider"), hostVoice: field("storyHostVoice"), cohostVoice: field("storyCohostVoice"),
  elevenHost: field("storyElevenHost"), elevenCohost: field("storyElevenCohost"), speed: field("storySpeed"),
};
const locationBox = field("storyLocations");
const voiceStatus = field("storyVoiceStatus");
const installButton = field("storyInstallLocal");
const saveStatus = field("storySaveStatus");
const saveButton = field("storySave");
const testButton = field("storyTestVoices");

let defaultInstructions = "";
let localVoice = { allowed: false, installed: false, installing: false };
let pollTimer = null;

function voiceText(voice) {
  if (!voice.allowed) return voice.reason;
  if (voice.installing) return voice.outdated ? "Updating local voice. This takes a minute, once." : "Installing local voice. This takes a few minutes, once, and stays on this computer.";
  if (voice.installError) return `Installing local voice failed: ${voice.installError}`;
  if (voice.installed) return "Local voice is installed on this node. Its voice model downloads on the first narration.";
  return "Local voice is not installed on this node. Install it to narrate with Kokoro here, without a key.";
}

// Only the voice line and its buttons change while an install runs, so a form being edited is never reset.
function showVoice(voice) {
  localVoice = voice;
  voiceStatus.textContent = voiceText(voice);
  installButton.disabled = !voice.allowed || voice.installed || voice.installing;
  testButton.disabled = !(voice.allowed && voice.installed);
  clearTimeout(pollTimer);
  if (voice.installing) pollTimer = setTimeout(async () => showVoice((await api("/api/story-settings")).voice), 3000);
}

function fill({ settings, defaultInstructions: defaults, locations, voices, voice }) {
  defaultInstructions = defaults;
  inputs.instructions.value = settings.instructions;
  for (const key of ["backdrops", "moods", "codeSlides", "codeWriteup", "ask", "narrate"]) inputs[key].checked = settings[key];
  inputs.maxCodeLines.value = settings.maxCodeLines;
  inputs.speed.value = settings.speed;
  inputs.voiceProvider.value = settings.voiceProvider;
  inputs.elevenHost.value = settings.elevenHostVoice;
  inputs.elevenCohost.value = settings.elevenCohostVoice;
  for (const key of ["hostVoice", "cohostVoice"]) {
    inputs[key].replaceChildren(...voices.map((item) => new Option(`${item.label} (${item.id})`, item.id)));
    inputs[key].value = settings[key];
  }
  locationBox.replaceChildren(...locations.map((place) => {
    const box = Object.assign(document.createElement("input"), { type: "checkbox", value: place.id, checked: settings.locations.includes(place.id) });
    box.dataset.testid = `story-location-${place.id}`;
    const label = document.createElement("label");
    label.className = "checkbox-row";
    label.append(box, ` ${place.label}`);
    return label;
  }));
  locationBox.hidden = !settings.backdrops;
  showVoice(voice);
}

const collect = () => ({
  instructions: inputs.instructions.value,
  backdrops: inputs.backdrops.checked,
  locations: [...locationBox.querySelectorAll("input:checked")].map((box) => box.value),
  moods: inputs.moods.checked,
  codeSlides: inputs.codeSlides.checked,
  codeWriteup: inputs.codeWriteup.checked,
  maxCodeLines: Number(inputs.maxCodeLines.value),
  ask: inputs.ask.checked,
  narrate: inputs.narrate.checked,
  voiceProvider: inputs.voiceProvider.value,
  hostVoice: inputs.hostVoice.value,
  cohostVoice: inputs.cohostVoice.value,
  elevenHostVoice: inputs.elevenHost.value.trim(),
  elevenCohostVoice: inputs.elevenCohost.value.trim(),
  speed: Number(inputs.speed.value),
  // Saving this tab is a choice of voice, so the first-use question is not asked afterwards.
  voiceChosen: true,
});

export async function loadStorySettings() {
  fill(await api("/api/story-settings"));
  saveStatus.textContent = "";
}

inputs.backdrops.addEventListener("change", () => { locationBox.hidden = !inputs.backdrops.checked; });
field("storyInstructionsReset").addEventListener("click", () => { inputs.instructions.value = defaultInstructions; });

saveButton.addEventListener("click", async () => {
  saveButton.disabled = true;
  try {
    fill(await api("/api/story-settings", { method: "PUT", body: JSON.stringify(collect()) }));
    saveStatus.textContent = "Saved on this node";
  } catch (error) {
    toast.error(error.message);
  } finally {
    saveButton.disabled = false;
  }
});

// Starts the download in the background on a computer that can run it; the status line follows it.
installButton.addEventListener("click", async () => {
  installButton.disabled = true;
  try {
    showVoice((await api("/api/story-settings/local-voice/install", { method: "POST" })).voice);
  } catch (error) {
    toast.error(error.message);
    installButton.disabled = false;
  }
});

// Speaks one sentence in each saved Kokoro voice, one after the other. Save first to hear a changed voice.
testButton.addEventListener("click", async () => {
  testButton.disabled = true;
  try {
    for (const who of ["host", "cohost"]) {
      const url = URL.createObjectURL(await apiBlob("/api/story-settings/test-voice", { method: "POST", body: JSON.stringify({ who }) }));
      const audio = new Audio(url);
      await new Promise((resolve, reject) => { audio.onended = resolve; audio.onerror = () => reject(new Error("The voice could not be played.")); void audio.play(); });
      URL.revokeObjectURL(url);
    }
  } catch (error) {
    toast.error(error.message);
  } finally {
    testButton.disabled = !(localVoice.allowed && localVoice.installed);
  }
});
