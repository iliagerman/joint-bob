// Settings → Webhooks → Files & tools. Each picked file becomes a staged card with its own type
// and description. On an existing webhook "Add file" uploads it; on a new one the cards upload
// after the webhook is created. Saved files edit their description in place.
import { api } from "./api.js";
import { createFittedList, formatBytes, makeButton, makeNode, makeTwoStepButton } from "./relay-ui.js";
import { byId, encodeFile, makeSegmented, saveBlob } from "./webhook-ui.js";

function textInput(testid, label, placeholder) {
  const input = document.createElement("input");
  input.dataset.testid = testid;
  input.placeholder = placeholder;
  input.maxLength = 2000;
  input.setAttribute("aria-label", label);
  return input;
}

/** `url(suffix)` addresses the current webhook, `run(work)` runs one guarded action. */
export function createWebhookFiles({ url, run, onCount }) {
  let hook = null;
  let resources = [];
  const staged = [];
  const stagedBox = byId("webhookResourceStaged");
  const picker = byId("webhookResourceFiles");

  const list = createFittedList({
    list: byId("webhookResourceList"), pager: byId("webhookResourcePager"), testPrefix: "webhook-resources",
    emptyText: "No files or tools yet.",
    fetchPage: async (page, size) => ({ total: resources.length, items: resources.slice((page - 1) * size, page * size) }),
    renderItem: fileRow,
  });

  async function reload() {
    resources = hook ? (await api(url("/resources"))).resources : [];
    onCount(resources.length);
    await list.reload();
  }

  function dropEntry(entry) {
    staged.splice(staged.indexOf(entry), 1);
    entry.card.remove();
  }

  async function upload(entry) {
    const { file } = entry;
    const description = entry.description.value.trim();
    if (!description) { entry.description.focus(); throw new Error(`Add a description for ${file.name} before adding it`); }
    await api(url("/resources"), { method: "POST", body: JSON.stringify({ kind: entry.kind, name: file.name, description, usage: entry.usage.value.trim() || null, mimeType: file.type || "application/octet-stream", data: await encodeFile(file) }) });
    dropEntry(entry);
  }

  function stageFile(file) {
    const entry = { file, kind: "file", card: makeNode("div", "webhooks-staged") };
    entry.description = textInput("webhook-resource-description-input", `Description for ${file.name}`, "What is this file and when should the agent use it?");
    entry.usage = textInput("webhook-resource-usage-input", `How to run ${file.name}`, `For example: python3 ${file.name} --help`);
    const usageRow = makeNode("label", "", "How to run");
    usageRow.append(entry.usage);
    usageRow.hidden = true;
    const kinds = makeSegmented([{ value: "file", label: "Static file", testid: "webhook-resource-kind-file" }, { value: "tool", label: "Tool or script", testid: "webhook-resource-kind-tool" }], "file", (kind) => { entry.kind = kind; usageRow.hidden = kind !== "tool"; });
    const descriptionRow = makeNode("label", "", "Description");
    descriptionRow.append(entry.description);
    entry.add = makeButton("Add file", "webhook-resource-add-button", () => void run(async () => { await upload(entry); await reload(); }), "primary compact");
    entry.add.hidden = !hook;
    const actions = makeNode("div", "relay-row-actions");
    actions.append(makeButton("Remove", "webhook-resource-remove-button", () => dropEntry(entry)), entry.add);
    const title = makeNode("div", "relay-row-title");
    title.append(makeNode("strong", "relay-row-name", file.name), makeNode("span", "relay-row-meta", formatBytes(file.size)));
    entry.card.append(title, kinds, descriptionRow, usageRow, actions);
    staged.push(entry);
    stagedBox.append(entry.card);
  }

  async function saveDetails(resource, description, usage) {
    const current = await api(url(`/resources/${resource.id}/download`));
    await api(url("/resources"), { method: "POST", body: JSON.stringify({ kind: resource.kind, resourceId: resource.id, name: resource.name, description: description.value, usage: usage?.value || null, mimeType: current.mimeType, data: current.data }) });
    await reload();
  }

  async function download(resource) {
    const current = await api(url(`/resources/${resource.id}/download`));
    const bytes = Uint8Array.from(atob(current.data), (character) => character.charCodeAt(0));
    saveBlob(current.name, new Blob([bytes], { type: current.mimeType || "application/octet-stream" }));
  }

  function fileRow(resource) {
    const row = makeNode("div", "relay-row webhooks-file-row");
    const name = makeNode("div", "relay-row-main");
    name.append(makeNode("strong", "relay-row-name", resource.name), makeNode("span", "relay-row-meta", `${resource.kind === "tool" ? "Tool" : "File"} · ${formatBytes(resource.bytes)}`));
    const notes = makeNode("div", "relay-row-main");
    const description = textInput("webhook-resource-description-edit", `Description for ${resource.name}`, "What the agent should know");
    description.value = resource.description;
    const usage = resource.kind === "tool" ? textInput("webhook-resource-usage-edit", `How to run ${resource.name}`, "How to run") : null;
    if (usage) usage.value = resource.usage ?? "";
    for (const input of [description, usage].filter(Boolean)) input.addEventListener("change", () => void run(() => saveDetails(resource, description, usage)));
    notes.append(description, ...(usage ? [usage] : []));
    const actions = makeNode("div", "relay-row-actions");
    const save = makeButton("⤓", "webhook-resource-download-button", () => void run(() => download(resource)));
    save.setAttribute("aria-label", `Download ${resource.name}`);
    const remove = makeTwoStepButton({ label: "✕", armedLabel: "Delete it?", testid: "webhook-resource-delete-button", onConfirm: () => run(async () => {
      await api(url(`/resources/${resource.id}`), { method: "DELETE" });
      await reload();
    }) });
    remove.setAttribute("aria-label", `Delete ${resource.name}`);
    actions.append(save, remove);
    row.append(name, notes, actions);
    return row;
  }

  function pick(files) {
    for (const file of files) stageFile(file);
  }

  byId("webhookResourceBrowse").addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => { pick(picker.files); picker.value = ""; });
  const zone = byId("webhookResourceDrop");
  zone.addEventListener("dragover", (event) => event.preventDefault());
  zone.addEventListener("drop", (event) => { event.preventDefault(); pick(event.dataTransfer.files); });

  return {
    /** Shows a webhook's files, or an empty page for a new one. Staged cards from before are dropped. */
    async open(next) {
      hook = next;
      for (const entry of [...staged]) dropEntry(entry);
      await reload();
    },
    /** The webhook now exists: staged cards can be added one by one. */
    attach(next) {
      hook = next;
      for (const entry of staged) entry.add.hidden = false;
    },
    /** The first staged file that cannot be uploaded yet, in the shape the save form reports. */
    missing() {
      const entry = staged.find((candidate) => !candidate.description.value.trim());
      return entry ? { tab: "files", element: entry.description, message: `Add a description for ${entry.file.name}, or remove it` } : null;
    },
    async uploadStaged() {
      for (const entry of [...staged]) await upload(entry);
      await reload();
    },
  };
}
