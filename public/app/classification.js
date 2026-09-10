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
  return {
    reset(labels) {
      select.disabled = !labels;
      select.replaceChildren(new Option(labels ? "Unclassified" : "Loading labels…", ""), ...(labels || []).map((name) => new Option(name, name)), new Option("Other…", "__other__"));
      other.value = "";
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
