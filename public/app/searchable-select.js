/**
 * A dropdown whose text box filters its options. Only a listed option can be chosen: typing
 * narrows the list, and leaving the box without choosing restores the current choice.
 *
 * Options are `{ value, label, detail? }`; the box shows the label and matches label, value, and detail.
 */
export function createSearchableSelect({ id, testid, placeholder = "Search", emptyText = "No matches" }) {
  const root = document.createElement("div");
  root.className = "project-combobox";
  const input = document.createElement("input");
  input.id = id; input.type = "search"; input.role = "combobox"; input.autocomplete = "off"; input.spellcheck = false;
  input.placeholder = placeholder; input.dataset.testid = testid; input.dataset.value = "";
  input.setAttribute("aria-autocomplete", "list"); input.setAttribute("aria-expanded", "false");
  const list = document.createElement("div");
  list.id = `${id}Options`; list.className = "project-combobox-options"; list.role = "listbox"; list.hidden = true; list.dataset.testid = `${testid}-options`;
  input.setAttribute("aria-controls", list.id);
  root.append(input, list);

  let options = [];
  let active = -1;
  const listeners = [];
  const selected = () => options.find((option) => option.value === input.dataset.value);
  const showSelected = () => { input.value = selected()?.label ?? input.dataset.value; };
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); };

  function highlight(index) {
    const items = [...list.querySelectorAll("[role='option']")];
    active = items.length ? (index + items.length) % items.length : -1;
    items.forEach((item, position) => item.classList.toggle("active", position === active));
    if (active < 0) { input.removeAttribute("aria-activedescendant"); return; }
    input.setAttribute("aria-activedescendant", items[active].id);
    items[active].scrollIntoView({ block: "nearest" });
  }

  function choose(option) {
    const changed = option.value !== input.dataset.value;
    input.dataset.value = option.value;
    showSelected(); close();
    if (changed) for (const listener of listeners) listener(option.value);
  }

  function render(query) {
    const needle = query.trim().toLocaleLowerCase();
    const matches = options.filter((option) => !needle || [option.label, option.value, option.detail].some((text) => text?.toLocaleLowerCase().includes(needle)));
    list.replaceChildren(...matches.map((option, index) => {
      const item = document.createElement("button");
      item.type = "button"; item.role = "option"; item.id = `${id}Option${index}`; item.tabIndex = -1;
      item.className = "project-combobox-option"; item.dataset.testid = `${testid}-option`; item.dataset.value = option.value;
      item.setAttribute("aria-selected", String(option.value === input.dataset.value));
      item.textContent = option.label;
      if (option.detail && option.detail !== option.label) {
        const detail = document.createElement("span"); detail.className = "project-combobox-option-detail"; detail.textContent = option.detail; item.append(detail);
      }
      item.addEventListener("mousedown", (event) => event.preventDefault());
      item.addEventListener("click", () => choose(option));
      return item;
    }));
    if (!matches.length) list.textContent = emptyText;
    highlight(0);
  }

  function open(query) { render(query); list.hidden = false; input.setAttribute("aria-expanded", "true"); }

  input.addEventListener("focus", () => { input.select(); open(""); });
  input.addEventListener("click", () => { if (list.hidden) open(""); });
  input.addEventListener("input", () => open(input.value));
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (list.hidden) open(""); else highlight(active + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter") {
      const item = list.querySelectorAll("[role='option']")[active];
      if (list.hidden || !item) return;
      event.preventDefault();
      item.click();
    } else if (event.key === "Escape" && !list.hidden) {
      // Keep the dialog open; only the list closes.
      event.preventDefault(); event.stopPropagation();
      showSelected(); close();
    }
  });
  input.addEventListener("blur", () => { showSelected(); close(); });

  return {
    root,
    input,
    get value() { return input.dataset.value; },
    /** Replaces the options. The current choice is kept, so a value missing from them must be listed by the caller to stay visible. */
    setOptions(next) { options = next; showSelected(); if (!list.hidden) render(input.value); },
    setValue(value) { input.dataset.value = value; showSelected(); },
    onChange(listener) { listeners.push(listener); },
  };
}
