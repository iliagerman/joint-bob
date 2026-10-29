// Settings → Webhooks → Memory. One switch turns the webhook's persistent Markdown note on. When
// on, the note can be edited, previewed, uploaded, downloaded and cleared. Saving checks that the
// agent did not change the note since it was read; a draft is never overwritten silently.
import { api } from "./api.js";
import { renderMarkdown } from "../markdown.js";
import { makeTwoStepButton } from "./relay-ui.js";
import { byId, errorText, makeSegmented, saveBlob } from "./webhook-ui.js";

const MAX_CHARACTERS = 200000;

/** `url(suffix)` addresses the current webhook, `run(work)` runs one guarded action. */
export function createWebhookMemory({ url, run, say, onEnabled }) {
  let revision = "";
  const enabled = byId("webhookMemoryEnabled");
  const content = byId("webhookMemoryContent");
  const preview = byId("webhookMemoryPreview");

  function show(memory) {
    enabled.checked = memory.enabled;
    content.value = memory.content;
    revision = memory.revision;
    byId("webhookMemoryOn").hidden = !memory.enabled;
    byId("webhookMemoryOff").hidden = memory.enabled;
    showMode("edit");
    updateSize();
    onEnabled(memory.enabled);
  }

  function updateSize() {
    byId("webhookMemorySize").textContent = `${(new Blob([content.value]).size / 1000).toFixed(1)} kB of ${MAX_CHARACTERS / 1000} kB`;
  }

  function showMode(mode) {
    content.hidden = mode !== "edit";
    preview.hidden = mode === "edit";
    if (mode === "preview") renderMarkdown(preview, content.value);
  }

  const read = async () => show(await api(url("/memory")));
  const write = async (text) => {
    const memory = await api(url("/memory"), { method: "PUT", body: JSON.stringify({ content: text, expectedRevision: revision }) });
    revision = memory.revision;
    content.value = text;
    updateSize();
  };

  // Not run through the shared `run` lock: the reload would otherwise drop a Save click made right after.
  async function setEnabled() {
    try {
      await api(url("/memory"), { method: "POST", body: JSON.stringify({ action: "enable", enabled: enabled.checked }) });
      await read();
    } catch (error) { say(errorText(error), "error"); }
  }

  async function upload(file) {
    if (!file.name.toLowerCase().endsWith(".md")) throw new Error("Choose a Markdown file ending in .md");
    const text = await file.text();
    if (!enabled.checked) { await api(url("/memory"), { method: "POST", body: JSON.stringify({ action: "enable", enabled: true }) }); await read(); }
    await write(text);
    say("Memory uploaded.", "ok");
  }

  byId("webhookMemoryModes").append(makeSegmented([{ value: "edit", label: "Edit", testid: "webhook-memory-mode-edit" }, { value: "preview", label: "Preview", testid: "webhook-memory-mode-preview" }], "edit", showMode));
  enabled.addEventListener("change", () => void setEnabled());
  content.addEventListener("input", updateSize);
  byId("webhookMemorySave").addEventListener("click", () => void run(async () => { await write(content.value); say("Memory saved.", "ok"); }));
  byId("webhookMemoryDiscard").addEventListener("click", () => void run(read));
  byId("webhookMemoryUploadButton").addEventListener("click", () => byId("webhookMemoryUpload").click());
  byId("webhookMemoryUpload").addEventListener("change", () => {
    const [file] = byId("webhookMemoryUpload").files;
    byId("webhookMemoryUpload").value = "";
    if (file) void run(() => upload(file));
  });
  byId("webhookMemoryDownload").addEventListener("click", () => saveBlob("MEMORY.md", new Blob([content.value], { type: "text/markdown;charset=utf-8" })));
  byId("webhookMemoryReset").replaceWith(makeTwoStepButton({ label: "Clear", armedLabel: "Erase it?", testid: "webhook-memory-reset-button", onConfirm: () => run(async () => { await write(""); say("Memory reset.", "ok"); }) }));

  return { open: (hook) => (hook ? read() : onEnabled(false)) };
}
