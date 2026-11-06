import { setTheme } from "./shell.js";

// Appearance (theme and text sizes) is per browser, not per account: a big screen wants larger text, a laptop does not,
// and a phone's theme must not change the desktop's.
const APPEARANCE_STORAGE_KEY = "jointBobAppearance";

export const THEMES = [
  { id: "light", label: "Light", base: "light" },
  { id: "dark", label: "Dark", base: "dark" },
  { id: "midnight", label: "Midnight", base: "dark" },
  { id: "graphite", label: "Graphite", base: "dark" },
  { id: "sepia", label: "Sepia", base: "light" },
];

export const SECTIONS = [
  { id: "projects", label: "Projects panel" },
  { id: "conversations", label: "Conversations panel" },
  { id: "chat", label: "Conversation" },
  { id: "activity", label: "Activity pane (on top of conversation)" },
  { id: "headers", label: "Headers" },
];

export const PRESETS = [
  { id: "default", label: "Default", global: 1 },
  { id: "large", label: "Large", global: 1.15 },
  { id: "larger", label: "Larger", global: 1.3 },
  { id: "huge", label: "Huge", global: 1.5 },
];

const MIN_SCALE = 0.8;
const MAX_SCALE = 2;
const STEP = 0.05;

const defaults = () => ({ theme: "", global: 1, sections: Object.fromEntries(SECTIONS.map((section) => [section.id, 1])) });

function clampScale(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  // Rounded after snapping, so 23 steps of 0.05 is 1.15 and not 1.1500000000000001.
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(Math.round(number / STEP) * STEP * 1e6) / 1e6));
}

function load() {
  const stored = JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) || "null");
  const settings = defaults();
  if (!stored) return settings;
  settings.theme = THEMES.some((theme) => theme.id === stored.theme) ? stored.theme : "";
  settings.global = clampScale(stored.global);
  for (const section of SECTIONS) settings.sections[section.id] = clampScale(stored.sections?.[section.id]);
  return settings;
}

let settings = load();

function save() {
  localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(settings));
}

/** Scale vars on the root; styles.css applies them as `zoom` on each section. */
function applyScales() {
  const root = document.documentElement.style;
  // Panels carry the global size; the activity pane sits inside the conversation and headers
  // inside their panel, so those two multiply on top of it.
  root.setProperty("--ui-zoom-projects", String(settings.global * settings.sections.projects));
  root.setProperty("--ui-zoom-conversations", String(settings.global * settings.sections.conversations));
  root.setProperty("--ui-zoom-chat", String(settings.global * settings.sections.chat));
  root.setProperty("--ui-zoom-activity", String(settings.sections.activity));
  root.setProperty("--ui-zoom-headers", String(settings.sections.headers));
}

function applyTheme() {
  const theme = THEMES.find((item) => item.id === settings.theme);
  if (!theme) {
    delete document.documentElement.dataset.palette;
    return;
  }
  setTheme(theme.base);
  if (theme.id === theme.base) delete document.documentElement.dataset.palette;
  else document.documentElement.dataset.palette = theme.id;
}

function currentThemeId() {
  const root = document.documentElement.dataset;
  return root.palette && THEMES.some((theme) => theme.id === root.palette && theme.base === root.theme) ? root.palette : root.theme;
}

const dialog = document.querySelector("#appearanceDialog");
const themeRow = dialog.querySelector("#appearanceThemes");
const presetRow = dialog.querySelector("#appearancePresets");
const sectionList = dialog.querySelector("#appearanceSections");
const globalLabel = dialog.querySelector("#appearanceGlobalValue");

function percent(scale) {
  return `${Math.round(scale * 100)}%`;
}

function choiceButton(label, testId, pressed, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost";
  button.textContent = label;
  button.dataset.testid = testId;
  button.setAttribute("aria-pressed", String(pressed));
  button.addEventListener("click", onClick);
  return button;
}

function sectionSlider(section) {
  const label = document.createElement("label");
  label.className = "appearance-slider";
  const name = document.createElement("span");
  name.textContent = section.label;
  const value = document.createElement("output");
  value.textContent = percent(settings.sections[section.id]);
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(MIN_SCALE);
  input.max = String(MAX_SCALE);
  input.step = String(STEP);
  input.value = String(settings.sections[section.id]);
  input.dataset.testid = `appearance-${section.id}-slider`;
  input.addEventListener("input", () => {
    settings.sections[section.id] = clampScale(input.value);
    value.textContent = percent(settings.sections[section.id]);
    applyScales();
    save();
    renderPresets();
  });
  label.append(name, value, input);
  return label;
}

function renderThemes() {
  const active = currentThemeId();
  themeRow.replaceChildren(...THEMES.map((theme) => choiceButton(theme.label, `appearance-theme-${theme.id}`, theme.id === active, () => {
    settings.theme = theme.id;
    applyTheme();
    save();
    renderThemes();
  })));
}

function renderPresets() {
  const sectionsDefault = SECTIONS.every((section) => settings.sections[section.id] === 1);
  globalLabel.textContent = percent(settings.global);
  presetRow.replaceChildren(...PRESETS.map((preset) => choiceButton(preset.label, `appearance-preset-${preset.id}`, sectionsDefault && preset.global === settings.global, () => {
    settings = { ...settings, global: preset.global, sections: defaults().sections };
    applyScales();
    save();
    render();
  })));
}

function render() {
  renderThemes();
  renderPresets();
  sectionList.replaceChildren(...SECTIONS.map(sectionSlider));
}

function open() {
  render();
  dialog.showModal();
}

const logo = document.querySelector("#brandMark");
logo.addEventListener("click", open);
logo.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  open();
});
// The Settings toggle flips plain light and dark, and is kept on this device like the palettes.
document.querySelector("#themeToggleButton").addEventListener("click", () => {
  settings.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme();
  save();
});
dialog.querySelector("#appearanceCloseButton").addEventListener("click", () => dialog.close());
dialog.querySelector("#appearanceResetButton").addEventListener("click", () => {
  settings = defaults();
  applyTheme();
  applyScales();
  save();
  render();
});

/** The display settings and what they allow, for Bob's display agent, which may change them from Bob's chat. */
export function appearanceContext() {
  return {
    settings: structuredClone(settings),
    themes: THEMES.map(({ id, label }) => ({ id, label })),
    sections: SECTIONS.map(({ id, label }) => ({ id, label })),
    scale: { min: MIN_SCALE, max: MAX_SCALE, step: STEP },
  };
}

/** Applies display settings chosen elsewhere (Bob's display agent, or its Undo), kept to what this page allows, as the dialog would. */
export function applyAppearance(next) {
  settings = {
    theme: THEMES.some((theme) => theme.id === next.theme) ? next.theme : "",
    global: clampScale(next.global),
    sections: Object.fromEntries(SECTIONS.map((section) => [section.id, clampScale(next.sections?.[section.id])])),
  };
  applyTheme();
  applyScales();
  save();
  if (dialog.open) render();
}

applyTheme();
applyScales();
