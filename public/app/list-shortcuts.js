/**
 * The first ten rows of every pick-list dialog carry a digit chip, and the same
 * digit activates that row while the dialog is open. 0 selects the tenth row, so
 * the number row alone reaches all ten.
 */

/** How deep the digit bindings run: keys 1-9 plus 0. */
export const LIST_SHORTCUT_LIMIT = 10;

/** The badge label for the row at `count`: 1-9 for the first nine, 0 for the tenth. */
export function shortcutLabel(count) {
  return count === LIST_SHORTCUT_LIMIT ? "0" : String(count);
}

/** The numbered chip drawn inside a shortcut row. */
export function shortcutIndexBadge(testid, count) {
  const badge = document.createElement("span");
  badge.className = "list-shortcut-index";
  badge.dataset.testid = testid;
  badge.textContent = shortcutLabel(count);
  return badge;
}

/** Digits typed into a text field belong to the field; checkboxes and radios take no text. */
function inTextField(event) {
  const field = event.target instanceof Element ? event.target.closest("input, textarea, select") : null;
  if (!(field instanceof HTMLInputElement)) return field !== null;
  return field.type !== "checkbox" && field.type !== "radio";
}

/** The 1-based row position the keystroke selects, or null when it is no shortcut. */
function shortcutPosition(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (inTextField(event)) return null;
  const position = event.key === "0" ? LIST_SHORTCUT_LIMIT : Number(event.key);
  if (!Number.isInteger(position) || position < 1 || position > LIST_SHORTCUT_LIMIT) return null;
  return position;
}

/**
 * Wires a dialog so digits open the row the latest render placed at that position.
 * `rows` hands over the shortcuts the render installed — a filtered or re-rendered
 * list therefore renumbers itself; `activate` receives the row and its position.
 */
export function attachDigitShortcuts(dialog, rows, activate) {
  dialog.addEventListener("keydown", (event) => {
    const position = shortcutPosition(event);
    if (position === null) return;
    const row = rows()[position - 1];
    if (!row) return;
    event.preventDefault();
    activate(row, position);
  });
}
