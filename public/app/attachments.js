import { elements } from "./elements.js";
import { toast } from "./shell.js";
import { state } from "./state.js";

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(`${reader.result || ""}`);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function resetAttachmentInput() {
  elements.attachmentInput.value = "";
}

function renderAttachmentChips(container, attachments, removeAttachment) {
  container.replaceChildren();
  for (const attachment of attachments) {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";
    const label = document.createElement("span");
    label.textContent = attachment.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.dataset.testid = "attachment-remove-button";
    remove.setAttribute("aria-label", `Remove ${attachment.name}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => removeAttachment(attachment.id));
    chip.append(label, remove);
    container.append(chip);
  }
}

function renderAttachments() {
  renderAttachmentChips(elements.attachmentList, state.attachments, (id) => {
    state.attachments = state.attachments.filter((item) => item.id !== id);
    renderAttachments();
  });
}

export function renderTaskAttachments() {
  renderAttachmentChips(elements.taskAttachmentList, state.taskAttachments, (id) => {
    state.taskAttachments = state.taskAttachments.filter((item) => item.id !== id);
    renderTaskAttachments();
  });
}

async function attachmentsFromFiles(fileList, current) {
  const files = [...fileList];
  const nextAttachments = [];
  for (const file of files) {
    if (file.size > 4 * 1024 * 1024) throw new Error(`${file.name} is too large. Keep files under 4MB.`);
    const dataUrl = await fileToDataUrl(file);
    const [, data = ""] = dataUrl.split(",", 2);
    const image = file.type.startsWith("image/");
    nextAttachments.push({ id: crypto.randomUUID(), kind: image ? "image" : "file", name: file.name, mimeType: file.type || (image ? "image/png" : "application/octet-stream"), data });
  }
  const attachments = [...current, ...nextAttachments];
  if (attachments.filter((attachment) => attachment.kind === "image").length > 4) throw new Error("Attach no more than 4 images.");
  if (attachments.filter((attachment) => attachment.kind === "file").length > 6) throw new Error("Attach no more than 6 files.");
  return attachments;
}

export async function addAttachments(fileList) {
  if (!fileList.length) return;
  state.attachments = await attachmentsFromFiles(fileList, state.attachments);
  renderAttachments();
  resetAttachmentInput();
}

export async function addTaskAttachments(fileList) {
  if (!fileList.length) return;
  state.taskAttachments = await attachmentsFromFiles(fileList, state.taskAttachments);
  renderTaskAttachments();
  elements.taskAttachmentInput.value = "";
}

export function clearAttachments() {
  state.attachments = [];
  renderAttachments();
  resetAttachmentInput();
}

export function clearTaskAttachments() {
  state.taskAttachments = [];
  renderTaskAttachments();
  elements.taskAttachmentInput.value = "";
}
elements.attachButton.addEventListener("click", () => elements.attachmentInput.click());
elements.attachmentInput.addEventListener("change", async (event) => {
  try {
    await addAttachments(event.target.files || []);
  } catch (error) {
    toast(error.message);
    resetAttachmentInput();
  }
});
