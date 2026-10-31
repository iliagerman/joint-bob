// Settings → Story mode: how stories are written, shown and spoken on this node.
import { api, apiBlob } from "./api.js";
import { toast } from "./shell.js";

const field = (id) => document.getElementById(id);
const inputs = {
  instructions: field("storyInstructions"), backdrops: field("storyBackdrops"), moods: field("storyMoods"), codeSlides: field("storyCodeSlides"),
  codeWriteup: field("storyCodeWriteup"), maxCodeLines: field("storyMaxCodeLines"), ask: field("storyAsk"), narrate: field("storyNarrate"),
  hostVoice: field("storyHostVoice"), cohostVoice: field("storyCohostVoice"), speed: field("storySpeed"),
};
const locationBox = field("storyLocations");
const voiceStatus = field("storyVoiceStatus");
const saveStatus = field("storySaveStatus");
const saveButton = field("storySave");
const testButton = field("storyTestVoices");

let defaultInstructions = "";
let voiceAvailable = false;

const TEST_SENTENCES = { host: "Hi, I'm Maya. I explain what changed and why.", cohost: "And I'm Jonah. I ask what a teammate would ask." };

function fill({ settings, defaultInstructions: defaults, locations, voices, voice }) {
  defaultInstructions = defaults;
  voiceAvailable = voice.available;
  inputs.instructions.value = settings.instructions;
  for (const key of ["backdrops", "moods", "codeSlides", "codeWriteup", "ask", "narrate"]) inputs[key].checked = settings[key];
  inputs.maxCodeLines.value = settings.maxCodeLines;
  inputs.speed.value = settings.speed;
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
  voiceStatus.textContent = voice.available ? "Kokoro is ready on this node." : voice.reason;
  testButton.disabled = !voice.available;
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
  hostVoice: inputs.hostVoice.value,
  cohostVoice: inputs.cohostVoice.value,
  speed: Number(inputs.speed.value),
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
    toast(error.message, 8000);
  } finally {
    saveButton.disabled = false;
  }
});

// Speaks one sentence in each saved voice, one after the other. The voices come from the saved settings, so save first to hear a change.
testButton.addEventListener("click", async () => {
  testButton.disabled = true;
  try {
    for (const who of ["host", "cohost"]) {
      const audio = new Audio(URL.createObjectURL(await apiBlob("/api/story-voice", { method: "POST", body: JSON.stringify({ text: TEST_SENTENCES[who], who }) })));
      await new Promise((resolve, reject) => { audio.onended = resolve; audio.onerror = () => reject(new Error("The voice could not be played.")); void audio.play(); });
      URL.revokeObjectURL(audio.src);
    }
  } catch (error) {
    toast(error.message, 8000);
  } finally {
    testButton.disabled = !voiceAvailable;
  }
});
