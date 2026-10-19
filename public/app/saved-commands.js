import { api } from "./api.js";
import { setInputValue } from "./composer.js";
import { elements } from "./elements.js";
import { state } from "./state.js";
import { toast } from "./shell.js";

const dialog = document.querySelector("#savedCommandsDialog");
const search = document.querySelector("#savedCommandsSearch");
const options = document.querySelector("#savedCommandsOptions");
let commands = [];
let recentIds = [];
let selected = 0;
let generation = 0;
let context;
const currentContext = () => ({ projectId: state.activeConversationProjectId || state.activeProjectId, conversationId: state.activeConversationId || undefined });
const sameContext = (capture) => JSON.stringify(capture) === JSON.stringify(currentContext());

async function choose(command) {
  const capture = context;
  const request = generation;
  const draft = elements.messageInput.value;
  try {
    await api(`/api/commands/${encodeURIComponent(command.id)}/use`, { method: "POST", body: JSON.stringify(capture) });
    if (request !== generation || !dialog.open || !sameContext(capture) || elements.messageInput.disabled || elements.messageInput.value !== draft) return;
    dialog.close();
    setInputValue(command.prompt);
    elements.messageInput.dispatchEvent(new Event("input", { bubbles: true }));
    elements.messageInput.focus();
  } catch (error) { if (request === generation && sameContext(capture)) toast(error.message); }
}

function render() {
  const query = search.value.trim().toLowerCase();
  const recent = recentIds.map((id) => commands.find((command) => command.id === id)).filter(Boolean).slice(0, 5);
  const matches = query ? commands.filter(({ name, prompt }) => `${name} ${prompt}`.toLowerCase().includes(query)) : recent.length ? recent : commands.slice(0, 5);
  document.querySelector("#savedCommandsTitle").textContent = !query && recent.length ? "Recently used commands" : "Commands";
  selected = Math.min(selected, Math.max(0, matches.length - 1));
  options.replaceChildren();
  if (!matches.length) options.textContent = "No commands found. Use + to add one.";
  matches.forEach((command, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "saved-command-option";
    button.dataset.testid = "saved-command-option";
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(index === selected));
    button.textContent = command.name;
    button.title = command.prompt;
    button.addEventListener("click", () => { void choose(command); });
    options.append(button);
  });
}

export async function openSavedCommands() {
  if (dialog.open || elements.messageInput.disabled || !elements.messageInput.checkVisibility()) return;
  const capture = currentContext();
  const request = ++generation;
  context = capture;
  commands = []; recentIds = []; selected = 0; search.value = "";
  dialog.showModal();
  options.textContent = "Loading commands…";
  search.focus();
  try {
    const params = new URLSearchParams({ projectId: capture.projectId });
    if (capture.conversationId) params.set("conversationId", capture.conversationId);
    const body = await api(`/api/commands?${params}`);
    if (request !== generation || !dialog.open) return;
    if (!sameContext(capture)) { dialog.close(); return; }
    commands = body.commands;
    recentIds = body.recentIds || [];
    render();
  } catch (error) {
    if (request === generation && dialog.open) { options.textContent = "Could not load commands. Close and try again."; toast(error.message); }
  }
}

const createDialog = document.querySelector("#createCommandDialog");
const createForm = document.querySelector("#createCommandForm");
const createName = document.querySelector("#createCommandName");
const createPrompt = document.querySelector("#createCommandPrompt");
document.querySelector("#createSavedCommand").addEventListener("click", () => {
  createForm.reset();
  createDialog.showModal();
  createName.focus();
});
document.querySelector("#cancelCreateCommand").addEventListener("click", () => createDialog.close());
createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const save = createForm.querySelector('[type="submit"]');
  if (save.disabled) return;
  save.disabled = true;
  const capture = context;
  const request = generation;
  try {
    const { command } = await api("/api/commands", { method: "POST", body: JSON.stringify({ name: createName.value.trim(), prompt: createPrompt.value.trim() }) });
    createDialog.close();
    if (request === generation && dialog.open && sameContext(capture)) {
      commands.push(command);
      search.value = command.name;
      selected = 0;
      render();
      search.focus();
    }
    toast("Command saved");
  } catch (error) { toast(error.message); }
  finally { save.disabled = false; }
});

document.querySelector("#savedCommandsButton").addEventListener("click", () => { void openSavedCommands(); });
document.querySelector("#closeSavedCommands").addEventListener("click", () => dialog.close());
search.addEventListener("input", () => { selected = 0; render(); });
search.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault(); event.stopPropagation(); dialog.close(); return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const count = options.querySelectorAll("button").length;
    if (!count) return;
    selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
    for (const [index, button] of [...options.children].entries()) button.setAttribute("aria-selected", String(index === selected));
    options.children[selected].scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter") {
    event.preventDefault();
    options.querySelectorAll("button")[selected]?.click();
  }
});
