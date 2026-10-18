import { fuzzyScore } from "./fuzzy.js";

const MAX_RESULTS = 8;
const MAX_LABEL_LENGTH = 160;

/**
 * Searches every settings section by name: tab names, field labels, legends and headings.
 * Results cover all tabs, so a search finds a setting before the user knows which tab holds it.
 * `isAvailable(tab)` hides tabs this account can't open; `onPick(tab, element, entry)` opens the match.
 */
export function createSettingsSearch({ input, results, tabs, panels, isAvailable, onPick, getExtraEntries = () => [] }) {
  let current = [];
  let active = 0;

  const tabName = (tab) => tab.querySelector(".settings-tab-label")?.textContent.trim() ?? tab.textContent.trim();
  const tabIcon = (tab) => tab.querySelector(".settings-tab-icon");
  /** A label's own words: a label wrapping a dropdown would otherwise read out every option. */
  const ownText = (element) => {
    if (!element.querySelector("select, textarea, button")) return element.textContent.replace(/\s+/g, " ").trim();
    const copy = element.cloneNode(true);
    for (const control of copy.querySelectorAll("select, textarea, button")) control.remove();
    return copy.textContent.replace(/\s+/g, " ").trim();
  };

  function index() {
    const entries = [];
    for (const tab of tabs) {
      if (!isAvailable(tab)) continue;
      const name = tabName(tab);
      entries.push({ tab, element: tab, title: name, section: "", key: name, search: name });
      const panel = panels.find((item) => item.id === `settingsPanel-${tab.dataset.settingsTab}`);
      if (!panel) continue;
      for (const element of panel.querySelectorAll("legend, label, h2, h3")) {
        // Skip anything the panel itself hides (admin-only rows, collapsed sections).
        if (element.closest("[hidden]:not(.settings-panel)")) continue;
        const title = ownText(element);
        if (!title || title.length > MAX_LABEL_LENGTH) continue;
        const section = element.closest("fieldset")?.querySelector("legend")?.textContent.replace(/\s+/g, " ").trim() ?? "";
        entries.push({ tab, element, title, section, key: `${name} › ${section || name}`, search: `${title} ${section} ${name}` });
      }
    }
    entries.push(...getExtraEntries());
    return entries;
  }

  function search(query) {
    const needle = query.trim();
    if (!needle) return [];
    const scored = [];
    for (const entry of index()) {
      // A title match outranks a match on the section or tab it sits in.
      const title = fuzzyScore(needle, entry.title);
      const context = fuzzyScore(needle, entry.search);
      const score = title !== null ? title + 100 : context !== null ? context : null;
      if (score !== null) scored.push({ ...entry, score });
    }
    return scored.sort((left, right) => right.score - left.score).slice(0, MAX_RESULTS);
  }

  function highlight(index) {
    const items = [...results.querySelectorAll("[role='option']")];
    active = items.length ? (index + items.length) % items.length : 0;
    items.forEach((item, position) => item.classList.toggle("active", position === active));
    items[active]?.scrollIntoView({ block: "nearest" });
  }

  function render() {
    const query = input.value;
    current = search(query);
    results.hidden = !query.trim();
    results.replaceChildren();
    if (!query.trim()) return;
    if (!current.length) {
      const empty = document.createElement("p");
      empty.className = "settings-search-empty";
      empty.textContent = `No settings match “${query.trim()}”`;
      results.append(empty);
      return;
    }
    current.forEach((entry, position) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "settings-search-result";
      row.setAttribute("role", "option");
      row.dataset.testid = "settings-search-result";
      const icon = tabIcon(entry.tab)?.cloneNode(true);
      if (icon) row.append(icon);
      const text = document.createElement("span");
      text.className = "settings-search-text";
      const title = document.createElement("strong");
      title.textContent = entry.title;
      const path = document.createElement("small");
      path.textContent = entry.key;
      text.append(title, path);
      row.append(text);
      row.addEventListener("mousedown", (event) => { event.preventDefault(); pick(position); });
      results.append(row);
    });
    highlight(0);
  }

  function pick(position) {
    const entry = current[position];
    if (!entry) return;
    input.value = "";
    results.hidden = true;
    onPick(entry.tab, entry.element, entry);
  }

  input.addEventListener("input", render);
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") { event.preventDefault(); highlight(active + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); highlight(active - 1); }
    else if (event.key === "Enter") { event.preventDefault(); pick(active); }
    else if (event.key === "Escape") { input.value = ""; results.hidden = true; }
  });
  input.addEventListener("blur", () => { results.hidden = true; });
  input.addEventListener("focus", () => { if (input.value.trim()) render(); });

  return {
    clear() { input.value = ""; results.hidden = true; },
    focus() { input.focus(); input.select(); },
  };
}
