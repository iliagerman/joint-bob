/** The icon chosen for a label, or "" when it shows as text only. */
export function labelIcon(name, icons) {
  return icons?.[name] || "";
}

/** Option and filter text: the icon leads the name, so the choice stays readable. */
export function labelOptionText(name, icons) {
  const icon = labelIcon(name, icons);
  return icon ? `${icon} ${name}` : name;
}

/** Native controls shared by the conversation dialog and the canvas picker. */
export function classificationPicker(container, prefix) {
  const label = document.createElement("label");
  label.textContent = "Classification";
  const select = document.createElement("select");
  select.dataset.testid = `${prefix}-classification-select`;
  label.append(select);
  const otherLabel = document.createElement("label");
  otherLabel.textContent = "Other classification";
  const other = document.createElement("input");
  other.maxLength = 80;
  other.autocomplete = "off";
  other.dataset.testid = `${prefix}-classification-other`;
  otherLabel.append(other);
  container.append(label, otherLabel);
  const sync = () => {
    otherLabel.hidden = select.value !== "__other__";
    other.disabled = otherLabel.hidden;
    other.required = !otherLabel.hidden;
    other.setCustomValidity("");
  };
  select.addEventListener("change", sync);
  other.addEventListener("input", () => other.setCustomValidity(""));
  // An icon leads each option's text, so the browser's own type-to-select never reaches
  // the label's first letter. Typed characters are matched against the names instead.
  let typed = "";
  let typedAt = 0;
  select.addEventListener("keydown", (event) => {
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
    if (Date.now() - typedAt > 1000) typed = "";
    // Space on its own opens the list; inside a name it is one more typed character.
    if (event.key === " " && !typed) return;
    event.preventDefault();
    typedAt = Date.now();
    typed += event.key.toLocaleLowerCase();
    // Repeating one letter walks through the names that start with it.
    const needle = [...typed].every((character) => character === typed[0]) ? typed[0] : typed;
    const options = [...select.options];
    const from = select.selectedIndex + (needle.length === 1 ? 1 : 0);
    for (let step = 0; step < options.length; step += 1) {
      const option = options[(from + step) % options.length];
      const name = option.value && option.value !== "__other__" ? option.value : option.text;
      if (!name.toLocaleLowerCase().startsWith(needle)) continue;
      if (option.index !== select.selectedIndex) {
        select.selectedIndex = option.index;
        select.dispatchEvent(new Event("input", { bubbles: true }));
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return;
    }
  });
  return {
    /** The wizard has to reveal the step holding this field before the browser can
        point at it, so it asks first rather than validating blind. */
    needsOther() {
      return select.value === "__other__" && !other.value.trim();
    },
    reset(labels, current = null, icons = {}) {
      select.disabled = !labels;
      select.replaceChildren(new Option(labels ? "Unclassified" : "Loading labels…", ""), ...(labels || []).map((name) => new Option(labelOptionText(name, icons), name)), new Option("Other…", "__other__"));
      const custom = current && !labels.includes(current);
      select.value = custom ? "__other__" : current || "";
      other.value = custom ? current : "";
      sync();
    },
    value() {
      if (select.value !== "__other__") return select.value || null;
      const value = other.value.trim();
      other.setCustomValidity(value ? "" : "Enter a classification");
      if (!other.reportValidity()) throw new Error("Enter a classification");
      return value;
    },
  };
}
