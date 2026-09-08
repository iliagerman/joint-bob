import { executeComposerCommand, LOCAL_COMMANDS } from "../composer-commands.js";
import { api } from "./api.js";
import { sendSocket } from "./chat-controls.js";
import { setInputValue } from "./composer.js";
import { elements } from "./elements.js";
import { brandIcon } from "./icons.js";
import { attachDigitShortcuts, isRowSelectorQuery, LIST_SHORTCUT_LIMIT, shortcutIndexBadge } from "./list-shortcuts.js";
import { normalizedQuery } from "./layout.js";
import { toast } from "./shell.js";
import { state } from "./state.js";

// Opus is pinned to the explicit Opus 5 id so the CLI's "opus" alias cannot
// drift to an older release.
export const CLAUDE_MODEL_OPTIONS = [
  { id: "fable", label: "Fable" },
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku 4.5" },
];
// Pi harness offers the GPT (openai-codex) and GLM (zai) models; Claude harness offers Fable/Opus/Sonnet.
export const PI_MODEL_PROVIDERS = [
  { provider: "openai-codex", groupLabel: "GPT (OpenAI Codex)" },
  { provider: "zai", groupLabel: "GLM (Z.ai)" },
];

export function syncModelButton() {
  const isClaude = state.engine === "claude";
  let label = "Model";
  if (isClaude) {
    const active = CLAUDE_MODEL_OPTIONS.find((option) => state.activeModelKey === `claude/${option.id}`);
    label = active?.label || state.activeModelLabel || "Model";
  } else {
    const active = state.models.find((model) => `${model.provider}/${model.id}` === state.activeModelKey);
    label = active?.label || state.activeModelLabel || "Model";
  }
  elements.modelButtonName.textContent = label;
  elements.modelButton.classList.toggle("claude", isClaude);
  if (elements.modelDialog.open) renderModelDialog();
}

/** Rows 1-10 carry a digit shortcut, in the order this render lists them. */
let modelShortcuts = [];

function modelOptionButton({ key, label, active, onSelect }) {
  const option = document.createElement("button");
  option.type = "button";
  option.className = "model-option";
  option.dataset.modelKey = key;
  option.dataset.testid = `model-option-${key.replace(/[^a-z0-9.-]+/gi, "-")}`;
  option.classList.toggle("active", active);
  if (modelShortcuts.length < LIST_SHORTCUT_LIMIT) {
    modelShortcuts.push(onSelect);
    option.append(shortcutIndexBadge("model-option-index", modelShortcuts.length));
  }
  option.append(document.createTextNode(label));
  option.addEventListener("click", () => {
    onSelect();
    elements.modelDialog.close();
  });
  return option;
}

/** Pi runs a skill as /skill:<name>; Claude runs it as a bare slash command. */
function skillInvocation(skill) {
  return skill.invocation || (skill.harness === "pi" ? `/skill:${skill.name} ` : `/${skill.name} `);
}

/** Rows 1-10 carry a digit shortcut; a filtered list renumbers on every keystroke. */
let skillShortcuts = [];

function chooseSkill(skill) {
  const invocation = skillInvocation(skill);
  elements.skillsDialog.close();
  elements.messageInput.value = invocation;
  elements.messageInput.focus();
  elements.messageInput.setSelectionRange(invocation.length, invocation.length);
}

function renderSkillsDialog() {
  elements.skillsDialogList.replaceChildren();
  skillShortcuts = [];
  if (state.skillsLoading) {
    const loading = document.createElement("span");
    loading.className = "model-shortcuts-empty";
    loading.textContent = "Loading skills…";
    elements.skillsDialogList.append(loading);
    return;
  }

  const typed = elements.skillsDialogSearchInput.value || "";
  const query = isRowSelectorQuery(typed) ? "" : normalizedQuery(typed);
  const matches = state.skills
    .filter((skill) => skill.harness === state.engine)
    .filter((skill) => !query || `${skill.name}\n${skill.description}`.toLowerCase().includes(query));

  if (!matches.length) {
    const empty = document.createElement("span");
    empty.className = "model-shortcuts-empty";
    empty.textContent = query ? "No matching skills." : "No skills installed for this agent.";
    elements.skillsDialogList.append(empty);
    return;
  }

  for (const skill of matches) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "skill-option";
    option.dataset.testid = "skill-option";
    if (skillShortcuts.length < LIST_SHORTCUT_LIMIT) {
      skillShortcuts.push(skill);
      option.append(shortcutIndexBadge("skill-option-index", skillShortcuts.length));
    }
    const name = document.createElement("strong");
    name.textContent = skill.name;
    if (skill.scope === "project") {
      const scope = document.createElement("em");
      scope.className = "skill-option-scope";
      scope.textContent = "project";
      name.append(" ", scope);
    }
    const description = document.createElement("span");
    description.className = "skill-option-description";
    description.textContent = skill.description;
    option.append(name, description);
    option.addEventListener("click", () => chooseSkill(skill));
    elements.skillsDialogList.append(option);
  }
}

export async function loadSkills(force = false) {
  const projectId = state.activeProjectId;
  if (!projectId) {
    state.skills = [];
    state.skillsProjectId = null;
    return;
  }
  if ((!force && state.skillsProjectId === projectId) || state.skillsLoading) return;
  state.skillsLoading = true;
  renderSkillsDialog();
  try {
    const body = await api(`/api/projects/${encodeURIComponent(projectId)}/skills`);
    if (state.activeProjectId !== projectId) return;
    state.skills = body.skills;
    state.skillsProjectId = projectId;
  } catch (error) {
    if (state.activeProjectId === projectId) {
      state.skills = [];
      state.skillsProjectId = projectId;
      toast(error.message);
    }
  } finally {
    if (state.activeProjectId === projectId) {
      state.skillsLoading = false;
      renderSkillsDialog();
      renderCommandAutocomplete();
    }
  }
}

async function openSkillsDialog() {
  elements.skillsDialogSearchInput.value = "";
  elements.skillsDialog.showModal();
  renderSkillsDialog();
  await loadSkills(true);
  if (elements.skillsDialog.open) elements.skillsDialogSearchInput.focus();
}

/** A digit toggles that tool row, exactly as clicking its checkbox does. */
let toolShortcuts = [];

function toolOption(tool) {
  const label = document.createElement("label");
  label.className = "tool-option";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = tool.active;
  checkbox.disabled = state.sessionBusy;
  checkbox.dataset.testid = "tools-dialog-tool-toggle";
  checkbox.addEventListener("change", () => {
    const toolNames = state.tools
      .filter((candidate) => candidate.name === tool.name ? checkbox.checked : candidate.active)
      .map((candidate) => candidate.name);
    if (!sendSocket({ type: "setTools", toolNames })) {
      checkbox.checked = !checkbox.checked;
      toast("Conversation is not connected yet");
      return;
    }
    state.toolsLoading = true;
    renderToolsDialog();
  });
  if (toolShortcuts.length < LIST_SHORTCUT_LIMIT) {
    toolShortcuts.push(checkbox);
    label.append(shortcutIndexBadge("tool-option-index", toolShortcuts.length));
  }
  const copy = document.createElement("span");
  const name = document.createElement("strong");
  name.textContent = tool.name;
  const description = document.createElement("span");
  description.className = "tool-option-description";
  description.textContent = tool.description;
  copy.append(name, description);
  label.append(checkbox, copy);
  return label;
}

export function renderToolsDialog() {
  elements.toolsDialogList.replaceChildren();
  toolShortcuts = [];
  if (state.toolsLoading) {
    const loading = document.createElement("span");
    loading.className = "model-shortcuts-empty";
    loading.textContent = "Loading tools…";
    elements.toolsDialogList.append(loading);
    return;
  }
  if (!state.tools.length) {
    const empty = document.createElement("span");
    empty.className = "model-shortcuts-empty";
    empty.textContent = state.engine === "claude"
      ? "Claude reports its tools after the first turn of a conversation."
      : "No tools are available for this session.";
    elements.toolsDialogList.append(empty);
    return;
  }
  for (const tool of state.tools) elements.toolsDialogList.append(toolOption(tool));
}

function openToolsDialog() {
  state.tools = [];
  state.toolsLoading = true;
  elements.toolsDialog.showModal();
  renderToolsDialog();
  if (!sendSocket({ type: "tools" })) {
    state.toolsLoading = false;
    renderToolsDialog();
    toast("Conversation is not connected yet");
  }
}

function openModelDialog() {
  renderModelDialog();
  elements.modelDialog.showModal();
}

export function composerCommandHandlers() {
  return {
    help: () => {
      setInputValue("/");
      elements.messageInput.focus();
      renderCommandAutocomplete();
    },
    skills: () => {
      setInputValue("");
      void openSkillsDialog();
    },
    model: () => {
      setInputValue("");
      openModelDialog();
    },
    tools: () => {
      setInputValue("");
      openToolsDialog();
    },
    compact: (instructions) => {
      setInputValue("");
      if (!sendSocket({ type: "compact", message: instructions })) {
        toast("Conversation is not connected yet");
        return;
      }
      toast("Compacting conversation…");
    },
  };
}

function commandSourceKey() {
  return `${state.activeProjectId}:${state.engine}`;
}

async function loadCommands() {
  const projectId = state.activeProjectId;
  const harness = state.engine;
  const key = commandSourceKey();
  if (!projectId || state.commandsLoading || state.commandsKey === key) return;
  state.commandsLoading = true;
  try {
    const body = await api(`/api/projects/${encodeURIComponent(projectId)}/commands?harness=${encodeURIComponent(harness)}`);
    if (commandSourceKey() !== key) return;
    state.commands = body.commands;
    state.commandsKey = key;
  } catch (error) {
    if (commandSourceKey() === key) {
      state.commands = [];
      state.commandsKey = key;
      toast(error.message);
    }
  } finally {
    if (commandSourceKey() === key) {
      state.commandsLoading = false;
      renderCommandAutocomplete();
    }
  }
}

function slashCommandQuery() {
  const { selectionStart, selectionEnd, value } = elements.messageInput;
  if (selectionStart !== selectionEnd || selectionEnd !== value.length) return null;
  const match = /^\/([^\s]*)$/.exec(value);
  return match ? match[1].toLowerCase() : null;
}

function commandMatchesQuery(command, query) {
  return !query || `${command.name}\n${command.description}`.toLowerCase().includes(query);
}

export function hideCommandAutocomplete() {
  state.commandSuggestions = [];
  state.commandAutocompleteIndex = 0;
  elements.commandAutocomplete.hidden = true;
  elements.messageInput.setAttribute("aria-expanded", "false");
  elements.messageInput.removeAttribute("aria-activedescendant");
}

export function commandAutocompleteOpen() {
  return !elements.commandAutocomplete.hidden && state.commandSuggestions.length > 0;
}

export function selectCommandSuggestion(index = state.commandAutocompleteIndex) {
  const suggestion = state.commandSuggestions[index];
  if (!suggestion) return;
  hideCommandAutocomplete();
  if (!executeComposerCommand(suggestion.invocation, composerCommandHandlers())) {
    setInputValue(suggestion.invocation);
    elements.messageInput.focus();
  }
}

export function renderCommandAutocomplete() {
  const query = slashCommandQuery();
  if (query === null || elements.messageInput.disabled) {
    hideCommandAutocomplete();
    return;
  }
  if (state.activeProjectId && state.commandsKey !== commandSourceKey()) void loadCommands();

  const commands = state.commandsKey === commandSourceKey()
    ? state.commands
    : LOCAL_COMMANDS.map((command) => ({ ...command, harness: state.engine }));
  state.commandSuggestions = commands
    .filter((command) => command.harness === state.engine)
    .filter((command) => commandMatchesQuery(command, query))
    .slice(0, 10);
  if (!state.commandSuggestions.length) {
    hideCommandAutocomplete();
    return;
  }

  state.commandAutocompleteIndex = Math.min(state.commandAutocompleteIndex, state.commandSuggestions.length - 1);
  elements.commandAutocomplete.replaceChildren();
  state.commandSuggestions.forEach((suggestion, index) => {
    const option = document.createElement("button");
    option.type = "button";
    option.id = `command-autocomplete-option-${index}`;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(index === state.commandAutocompleteIndex));
    option.dataset.testid = "chat-command-autocomplete-option";
    const name = document.createElement("span");
    name.className = "command-autocomplete-name";
    name.textContent = suggestion.invocation.trim();
    const description = document.createElement("span");
    description.className = "command-autocomplete-description";
    description.textContent = suggestion.description;
    option.append(name, description);
    option.addEventListener("pointerdown", (event) => event.preventDefault());
    option.addEventListener("click", () => selectCommandSuggestion(index));
    elements.commandAutocomplete.append(option);
  });
  elements.commandAutocomplete.hidden = false;
  elements.messageInput.setAttribute("aria-expanded", "true");
  elements.messageInput.setAttribute("aria-activedescendant", `command-autocomplete-option-${state.commandAutocompleteIndex}`);
  elements.commandAutocomplete.children[state.commandAutocompleteIndex]?.scrollIntoView({ block: "nearest" });
}

export function renderReasoningOptions() {
  const hasLevels = state.availableThinkingLevels.length > 0;
  elements.chatModeLabel.textContent = state.engine === "claude" ? "Effort" : "Thinking";
  elements.reasoningLevelSelect.replaceChildren();
  for (const level of state.availableThinkingLevels) {
    const option = document.createElement("option");
    option.value = level;
    option.textContent = level;
    elements.reasoningLevelSelect.append(option);
  }
  elements.reasoningLevelSelect.value = state.thinkingLevel;
  elements.chatModeControl.hidden = !hasLevels;
}

export function changeReasoningLevel(event) {
  const level = event.currentTarget.value;
  const payload = state.engine === "claude"
    ? { type: "setEffort", effort: level }
    : { type: "setThinking", level };
  if (!sendSocket(payload)) toast("Not connected");
}

function renderModelDialog() {
  const isClaude = state.engine === "claude";
  elements.modelDialogTitle.textContent = isClaude ? "Claude model" : "Pi model";
  elements.modelDialogList.classList.toggle("claude", isClaude);
  elements.modelDialogList.replaceChildren();
  modelShortcuts = [];
  if (isClaude) {
    for (const option of CLAUDE_MODEL_OPTIONS) {
      elements.modelDialogList.append(
        modelOptionButton({
          key: `claude/${option.id}`,
          label: option.label,
          active: state.activeModelKey === `claude/${option.id}`,
          onSelect: () => {
            if (!sendSocket({ type: "setModel", provider: "claude", modelId: option.id })) toast("Not connected");
          },
        }),
      );
    }
    return;
  }
  if (!state.models.length) {
    const empty = document.createElement("span");
    empty.className = "model-shortcuts-empty";
    empty.textContent = "No configured models";
    elements.modelDialogList.append(empty);
    return;
  }
  for (const { provider, groupLabel } of PI_MODEL_PROVIDERS) {
    const group = state.models.filter((model) => model.provider === provider);
    if (!group.length) continue;
    const heading = document.createElement("div");
    heading.className = "model-dialog-group";
    // Z.ai publishes no monochrome mark, so only GPT carries a logo here.
    if (provider === "openai-codex") heading.append(brandIcon("openai", "model-group-icon"));
    heading.append(document.createTextNode(groupLabel));
    elements.modelDialogList.append(heading);
    for (const model of group) {
      elements.modelDialogList.append(
        modelOptionButton({
          key: `${model.provider}/${model.id}`,
          label: model.label,
          active: state.activeModelKey === `${model.provider}/${model.id}`,
          onSelect: () => {
            if (!sendSocket({ type: "setModel", provider: model.provider, modelId: model.id })) toast("Not connected");
          },
        }),
      );
    }
  }
}
elements.skillsDialogSearchInput.addEventListener("input", () => renderSkillsDialog());
elements.closeSkillsDialogButton.addEventListener("click", () => elements.skillsDialog.close());
elements.closeToolsDialogButton.addEventListener("click", () => elements.toolsDialog.close());
elements.modelButton.addEventListener("click", openModelDialog);
attachDigitShortcuts(elements.skillsDialog, () => skillShortcuts, (skill) => chooseSkill(skill));
attachDigitShortcuts(elements.toolsDialog, () => toolShortcuts, (checkbox) => checkbox.click());
attachDigitShortcuts(elements.modelDialog, () => modelShortcuts, (onSelect) => {
  onSelect();
  elements.modelDialog.close();
});
