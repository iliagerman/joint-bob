import { api } from "./api.js";
import { setInputValue } from "./composer.js";
import { elements } from "./elements.js";
import { toast } from "./shell.js";

const dialog = document.querySelector("#savedCommandsDialog");
const search = document.querySelector("#savedCommandsSearch");
const options = document.querySelector("#savedCommandsOptions");
let commands = [];
let selected = 0;

function render() {
  const matches = commands.filter(({ name, prompt }) => `${name} ${prompt}`.toLowerCase().includes(search.value.toLowerCase()));
  selected = Math.min(selected, Math.max(0, matches.length - 1));
  options.replaceChildren();
  if (!matches.length) options.textContent = "No saved commands found.";
  matches.forEach(({ name, prompt }, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "saved-command-option";
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(index === selected));
    button.textContent = name;
    button.title = prompt;
    button.addEventListener("click", () => {
      dialog.close();
      setInputValue(prompt);
      elements.messageInput.dispatchEvent(new Event("input", { bubbles: true }));
      elements.messageInput.focus();
    });
    options.append(button);
  });
}

export async function openSavedCommands() {
  if (dialog.open || elements.messageInput.disabled || !elements.messageInput.checkVisibility()) return;
  try {
    const settings = await api("/api/settings");
    commands = settings.conversationCommands?.presets || [];
    if (!commands.length) { toast("No saved commands. Add one in Settings → Commands."); return; }
    selected = 0;
    search.value = "";
    render();
    dialog.showModal();
    search.focus();
  } catch (error) {
    toast(error.message);
  }
}

document.querySelector("#savedCommandsButton").addEventListener("click", () => { void openSavedCommands(); });
document.querySelector("#closeSavedCommands").addEventListener("click", () => dialog.close());
search.addEventListener("input", () => { selected = 0; render(); });
search.addEventListener("keydown", (event) => {
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
