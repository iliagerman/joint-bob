// "Put my cursor where I can type." A dialog on top owns the keyboard, so its own
// field wins; with nothing open, the conversation composer does. Everything here is
// about the top-level document - a canvas pane is an iframe and the canvas reaches
// into it separately.

const FIELDS = 'input:not([type="hidden"]):not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly]), select:not([disabled])';

/** A hidden panel still has its elements, so "is it on screen" is the real question.
 *  Client rects rather than `offsetParent`: a modal dialog is in the browser's top
 *  layer, where its children report no offset parent at all. */
const onScreen = (element) => Boolean(element?.getClientRects().length);

/**
 * The dialog the user is actually looking at. `showModal` stacks by call order rather
 * than by document order, so a dialog holding the focus is the top one; failing that,
 * the last one the document declares is the closest guess.
 */
function topmostOpenDialog() {
  const open = [...document.querySelectorAll("dialog[open]")];
  if (!open.length) return null;
  return open.find((dialog) => dialog.contains(document.activeElement)) ?? open.at(-1);
}

/**
 * Focuses the field the keyboard should reach, and reports whether it found one.
 * A false answer means this document had nowhere to type - on the canvas that is the
 * signal to hand the keystroke to the conversation the user is working in.
 */
export function focusTopmostInput() {
  const dialog = topmostOpenDialog();
  if (dialog) {
    const field = [...dialog.querySelectorAll(FIELDS)].find(onScreen);
    if (!field) return false;
    field.focus();
    if (typeof field.select === "function" && field.value) field.select();
    return true;
  }
  const composer = document.querySelector("#messageInput");
  if (!onScreen(composer) || composer.disabled) return false;
  composer.focus();
  return true;
}
