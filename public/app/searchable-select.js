/**
 * A dropdown with a search box. The closed control looks and acts like a select: it shows the
 * current choice behind a chevron and cannot be typed into. Opening it shows a search box over
 * the list; typing narrows the list, and only a listed option can be chosen.
 *
 * Options are `{ value, label, detail? }`; search matches label, value, and detail.
 */
export function createSearchableSelect({ id, testid, label, prompt = "Choose…", placeholder = "Search", emptyText = "No matches", optionTestid = `${testid}-option`, listTestid = `${testid}-options`, icon }) {
  const root = document.createElement("div");
  root.className = "searchable-select";
  const trigger = document.createElement("button");
  trigger.type = "button"; trigger.id = id; trigger.className = "searchable-select-trigger";
  trigger.dataset.testid = testid; trigger.dataset.value = "";
  trigger.setAttribute("aria-haspopup", "listbox"); trigger.setAttribute("aria-expanded", "false");
  const popover = document.createElement("div");
  popover.className = "searchable-select-popover"; popover.hidden = true;
  const search = document.createElement("input");
  search.type = "search"; search.role = "combobox"; search.autocomplete = "off"; search.spellcheck = false;
  search.placeholder = placeholder; search.dataset.testid = `${testid}-search`;
  search.setAttribute("aria-autocomplete", "list"); search.setAttribute("aria-expanded", "true");
  const list = document.createElement("div");
  list.id = `${id}Options`; list.className = "searchable-select-options"; list.role = "listbox"; list.dataset.testid = listTestid;
  search.setAttribute("aria-controls", list.id); trigger.setAttribute("aria-controls", list.id);
  if (label) { trigger.setAttribute("aria-label", label); search.setAttribute("aria-label", `Search ${label.toLocaleLowerCase()}`); }
  popover.append(search, list);
  root.append(trigger, popover);

  let options = [];
  let active = -1;
  const listeners = [];
  const selected = () => options.find((option) => option.value === trigger.dataset.value);
  const showSelected = () => {
    const label = selected()?.label ?? trigger.dataset.value;
    trigger.replaceChildren(...(label && icon ? [icon(trigger.dataset.value)] : []), document.createTextNode(label || prompt));
    trigger.classList.toggle("empty", !label);
  };

  function close({ focusTrigger = false } = {}) {
    popover.hidden = true; trigger.setAttribute("aria-expanded", "false"); search.removeAttribute("aria-activedescendant");
    if (focusTrigger) trigger.focus();
  }

  function highlight(index) {
    const items = [...list.querySelectorAll("[role='option']")];
    active = items.length ? (index + items.length) % items.length : -1;
    items.forEach((item, position) => item.classList.toggle("active", position === active));
    if (active < 0) { search.removeAttribute("aria-activedescendant"); return; }
    search.setAttribute("aria-activedescendant", items[active].id);
    items[active].scrollIntoView({ block: "nearest" });
  }

  function choose(option) {
    const changed = option.value !== trigger.dataset.value;
    trigger.dataset.value = option.value;
    showSelected(); close({ focusTrigger: true });
    if (changed) for (const listener of listeners) listener(option.value);
  }

  function render() {
    const needle = search.value.trim().toLocaleLowerCase();
    const matches = options.filter((option) => !needle || [option.label, option.value, option.detail].some((text) => text?.toLocaleLowerCase().includes(needle)));
    list.replaceChildren(...matches.map((option, index) => {
      const item = document.createElement("button");
      item.type = "button"; item.role = "option"; item.id = `${id}Option${index}`; item.tabIndex = -1;
      item.className = "searchable-select-option"; item.dataset.testid = optionTestid; item.dataset.value = option.value;
      item.setAttribute("aria-selected", String(option.value === trigger.dataset.value));
      if (icon) item.append(icon(option.value));
      item.append(document.createTextNode(option.label));
      if (option.detail && option.detail !== option.label) {
        const detail = document.createElement("span"); detail.className = "searchable-select-option-detail"; detail.textContent = option.detail; item.append(detail);
      }
      item.addEventListener("mousedown", (event) => event.preventDefault());
      item.addEventListener("click", () => choose(option));
      return item;
    }));
    if (!matches.length) list.textContent = emptyText;
    const current = matches.findIndex((option) => option.value === trigger.dataset.value);
    highlight(needle || current < 0 ? 0 : current);
  }

  function open() {
    search.value = ""; popover.hidden = false; trigger.setAttribute("aria-expanded", "true");
    render(); search.focus();
  }

  trigger.addEventListener("click", () => (popover.hidden ? open() : close()));
  trigger.addEventListener("keydown", (event) => {
    if (["ArrowDown", "ArrowUp"].includes(event.key) && popover.hidden) { event.preventDefault(); open(); }
  });
  search.addEventListener("input", render);
  search.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      highlight(active + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      list.querySelectorAll("[role='option']")[active]?.click();
    } else if (event.key === "Escape") {
      // Keep the dialog open; only the list closes.
      event.preventDefault(); event.stopPropagation();
      close({ focusTrigger: true });
    } else if (event.key === "Tab") {
      close();
    }
  });
  root.addEventListener("focusout", (event) => { if (!root.contains(event.relatedTarget)) close(); });

  showSelected();
  return {
    root,
    trigger,
    get value() { return trigger.dataset.value; },
    /** Replaces the options. The current choice is kept, so a value missing from them must be listed by the caller to stay visible. */
    setOptions(next) { options = next; showSelected(); if (!popover.hidden) render(); },
    setValue(value) { trigger.dataset.value = value; showSelected(); },
    get disabled() { return trigger.disabled; },
    set disabled(value) { trigger.disabled = value; if (value) close(); },
    onChange(listener) { listeners.push(listener); },
  };
}
