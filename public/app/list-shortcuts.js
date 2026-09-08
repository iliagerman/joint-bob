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

/**
 * A search box holding nothing but one digit is naming a row, not searching for text.
 * Every filtered list asks this before narrowing itself, so the number the user typed
 * still points at the row they can see rather than at a list that moved underneath it.
 */
export function isRowSelectorQuery(value) {
  return /^[0-9]$/.test(String(value ?? "").trim());
}

/** The row a search box is naming, or null when it holds a real query. */
function typedRowSelector(event) {
  if (event.key !== "Enter" || event.metaKey || event.ctrlKey || event.altKey) return null;
  const field = event.target;
  if (!(field instanceof HTMLInputElement) || !isRowSelectorQuery(field.value)) return null;
  const typed = field.value.trim();
  return { field, position: typed === "0" ? LIST_SHORTCUT_LIMIT : Number(typed) };
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
  // Capture, not bubble: a dialog with a search box has its own Enter handler, and the
  // row a digit names must win over whichever row that handler would have opened.
  dialog.addEventListener("keydown", (event) => {
    const typed = typedRowSelector(event);
    const position = typed ? typed.position : shortcutPosition(event);
    if (position === null) return;
    const row = rows()[position - 1];
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    if (typed) {
      // The list re-renders from an empty box, so a dialog that stays open (a
      // checkbox list) is left showing everything rather than the digit.
      typed.field.value = "";
      typed.field.dispatchEvent(new Event("input", { bubbles: true }));
    }
    activate(row, position);
  }, true);
}
