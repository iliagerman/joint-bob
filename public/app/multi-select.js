import { fuzzyMatch } from "./fuzzy.js";

/**
 * A filter dropdown that holds several choices at once. Closed, it reads like a select:
 * the prompt when nothing is chosen ("All labels"), otherwise the chosen names. Open, it
 * lists every option with a check mark; clicking toggles one and keeps the list open.
 * Longer lists get a fuzzy search box. Nothing chosen means no filtering.
 *
 * Options are `{ value, label, detail? }`.
 */
export function createMultiSelect({ id, testid, label, prompt, placeholder = "Search", emptyText = "No matches" }) {
  const root = document.createElement("div");
  root.className = "searchable-select multi-select";
  root.dataset.testid = testid;
  const trigger = document.createElement("button");
  trigger.type = "button"; trigger.id = id; trigger.className = "searchable-select-trigger multi-select-trigger";
  trigger.dataset.testid = `${testid}-trigger`;
  trigger.setAttribute("aria-haspopup", "listbox"); trigger.setAttribute("aria-expanded", "false");
  const popover = document.createElement("div");
  popover.className = "searchable-select-popover"; popover.hidden = true;
  const search = document.createElement("input");
  search.type = "search"; search.autocomplete = "off"; search.spellcheck = false;
  search.placeholder = placeholder; search.dataset.testid = `${testid}-search`;
  search.setAttribute("aria-label", `Search ${label.toLocaleLowerCase()}`);
  const list = document.createElement("div");
  list.id = `${id}Options`; list.className = "searchable-select-options"; list.role = "listbox";
  list.setAttribute("aria-multiselectable", "true"); list.setAttribute("aria-label", label);
  list.dataset.testid = `${testid}-options`;
  const clear = document.createElement("button");
  clear.type = "button"; clear.className = "multi-select-clear"; clear.textContent = "Clear";
  clear.dataset.testid = `${testid}-clear`;
  trigger.setAttribute("aria-controls", list.id);
  popover.append(search, list, clear);
  root.append(trigger, popover);

  let options = [];
  let values = new Set();
  let active = -1;
  const listeners = [];

  function summary() {
    const chosen = options.filter((option) => values.has(option.value));
    if (!values.size) return prompt;
    // A chosen value can outlive its option (a retired label); still count it.
    if (chosen.length !== values.size || chosen.length > 2) return `${label}: ${values.size} selected`;
    return chosen.map((option) => option.label).join(", ");
  }

  function showSummary() {
    trigger.textContent = summary();
    trigger.title = trigger.textContent;
    trigger.classList.toggle("empty", !values.size);
    trigger.setAttribute("aria-label", `${label}: ${values.size ? summary() : prompt}`);
    clear.hidden = !values.size;
  }

  function emit() { showSummary(); for (const listener of listeners) listener(new Set(values)); }

  function close({ focusTrigger = false } = {}) {
    popover.hidden = true; trigger.setAttribute("aria-expanded", "false");
    if (focusTrigger) trigger.focus();
  }

  function highlight(index) {
    const items = [...list.querySelectorAll("[role='option']")];
    active = items.length ? (index + items.length) % items.length : -1;
    items.forEach((item, position) => item.classList.toggle("active", position === active));
    if (active >= 0) items[active].scrollIntoView({ block: "nearest" });
  }

  function toggle(value) {
    if (values.has(value)) values.delete(value); else values.add(value);
    for (const item of list.querySelectorAll("[role='option']")) item.setAttribute("aria-selected", String(values.has(item.dataset.value)));
    emit();
  }

  function render() {
    const query = search.value.trim();
    const matches = query
      ? options.map((option) => ({ option, score: fuzzyMatch(query, option.label, option.detail) }))
        .filter(({ score }) => score !== null).sort((left, right) => right.score - left.score).map(({ option }) => option)
      : options;
    list.replaceChildren(...matches.map((option, index) => {
      const item = document.createElement("button");
      item.type = "button"; item.role = "option"; item.id = `${id}Option${index}`; item.tabIndex = -1;
      item.className = "searchable-select-option multi-select-option"; item.dataset.testid = `${testid}-option`; item.dataset.value = option.value;
      item.setAttribute("aria-selected", String(values.has(option.value)));
      const text = document.createElement("span"); text.className = "multi-select-option-label"; text.textContent = option.label;
      item.append(text);
      if (option.detail && option.detail !== option.label) {
        const detail = document.createElement("span"); detail.className = "searchable-select-option-detail"; detail.textContent = option.detail; item.append(detail);
      }
      item.addEventListener("mousedown", (event) => event.preventDefault());
      item.addEventListener("click", () => toggle(option.value));
      return item;
    }));
    if (!matches.length) list.textContent = emptyText;
    highlight(0);
  }

  function open() {
    search.value = ""; search.hidden = options.length < 7;
    popover.hidden = false; trigger.setAttribute("aria-expanded", "true");
    render();
    (search.hidden ? list.querySelector("[role='option']") || clear : search).focus();
  }

  trigger.addEventListener("click", () => (popover.hidden ? open() : close()));
  trigger.addEventListener("keydown", (event) => {
    if (["ArrowDown", "ArrowUp"].includes(event.key) && popover.hidden) { event.preventDefault(); open(); }
  });
  search.addEventListener("input", render);
  popover.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      highlight(active + (event.key === "ArrowDown" ? 1 : -1));
      if (search.hidden) list.querySelectorAll("[role='option']")[active]?.focus();
    } else if (event.key === "Enter" && event.target === search) {
      event.preventDefault();
      list.querySelectorAll("[role='option']")[active]?.click();
    } else if (event.key === "Escape") {
      // Keep the surrounding dialog open; only the list closes.
      event.preventDefault(); event.stopPropagation();
      close({ focusTrigger: true });
    }
  });
  clear.addEventListener("mousedown", (event) => event.preventDefault());
  clear.addEventListener("click", () => { values.clear(); render(); emit(); close({ focusTrigger: true }); });
  root.addEventListener("focusout", (event) => { if (!root.contains(event.relatedTarget)) close(); });

  showSummary();
  return {
    root,
    trigger,
    get values() { return new Set(values); },
    /** Replaces the options and keeps the current choices, including ones no longer listed. */
    setOptions(next) { options = next; showSummary(); if (!popover.hidden) render(); },
    /** Sets the choices without notifying listeners. */
    setValues(next) { values = new Set(next); showSummary(); if (!popover.hidden) render(); },
    onChange(listener) { listeners.push(listener); },
  };
}
