import { CANVAS_MODIFIERS, canvasKeyFromCode, chordFromEvent, chordLabel, normalizeChord } from "../canvas-layout.js";

const modifierTokenForCode = (code) => ({ ControlLeft: "ctrl", ControlRight: "ctrl", MetaLeft: "meta", MetaRight: "meta", AltLeft: "alt", AltRight: "alt", ShiftLeft: "shift", ShiftRight: "shift" })[code] || null;

/**
 * Turns a text field into a shortcut recorder: press and hold the keys - modifiers
 * included - and the chord of up to four keys is captured exactly as it is held.
 * Backspace or Delete clears the field to unbind; Escape hands focus back. A key
 * without Command, Control, or Option held beside it previews and then steps back to
 * what was committed, so ordinary typing never lands in the field.
 *
 * `modifierOnly` records the bare modifier chord a conversation key rides under:
 * hold the modifiers and let go, and the release commits the combination that was
 * held at its widest.
 */
export function captureChordInput(input, { modifierOnly = false } = {}) {
  let held = new Set();
  let peak = new Set();
  const committed = () => (input.dataset.chord ? JSON.parse(input.dataset.chord) : null);
  const show = (chord) => {
    input.dataset.chord = chord ? JSON.stringify(chord) : "";
    input.value = chord ? chordLabel(chord) : "";
  };
  const restore = () => {
    const chord = committed();
    input.value = chord ? chordLabel(chord) : "";
  };

  input.addEventListener("keydown", (event) => {
    // A chord being recorded belongs to this field, not the app-wide dispatcher.
    event.stopPropagation();
    if (event.code === "Backspace" || event.code === "Delete") {
      event.preventDefault();
      show(null);
      return;
    }
    if (event.code === "Escape") {
      event.preventDefault();
      restore();
      input.blur();
      return;
    }
    const token = modifierTokenForCode(event.code);
    if (token) {
      held.add(token);
      peak.add(token);
      // Modifiers going down preview the chord they are building, so the field shows
      // the capture happening instead of waiting silently for the key to arrive.
      const modifiers = CANVAS_MODIFIERS.filter((name) => held.has(name));
      if (normalizeChord(modifiers, { modifierOnly: true })) input.value = chordLabel(modifiers);
      return;
    }
    const chord = chordFromEvent(event);
    const key = chord ? null : canvasKeyFromCode(event.code);
    if (!chord && !key) return; // Tab, the F keys, and friends keep their usual job.
    if (!chord) {
      // An unbindable press: a bare key, or a fifth key already held. Show the key,
      // then let its release put the committed chord back.
      event.preventDefault();
      input.value = chordLabel([key]);
      return;
    }
    // The chord stays in the field: recording ⌘⇧P must not open the search bar whose
    // key that is. The handler opened by stopping propagation on the way in.
    event.preventDefault();
    show(chord);
  });
  input.addEventListener("keyup", (event) => {
    const token = modifierTokenForCode(event.code);
    if (!token) {
      // The last key of a chord is already committed into the field; anything else
      // (a bare key the recorder refused, a preview) steps back to what is committed.
      restore();
      return;
    }
    held.delete(token);
    if (!modifierOnly) {
      restore();
      return;
    }
    // The last modifier going back up commits the combination the fingers just
    // described: the widest set held during the press, so releasing one modifier
    // before the others does not shrink the chord to whatever left last.
    if (!held.size) {
      const candidate = normalizeChord(CANVAS_MODIFIERS.filter((name) => peak.has(name)), { modifierOnly: true });
      if (candidate) show(candidate);
      else restore();
      peak = new Set();
    }
  });
  input.addEventListener("blur", () => { held = new Set(); peak = new Set(); restore(); });
  input.addEventListener("focus", () => { held = new Set(); peak = new Set(); });
}

/**
 * Records one key from the conversation-binding vocabulary: the key a canvas
 * conversation holds under the account's base chord. Enter and the punctuation keys
 * either type nothing or type something a plain field would mangle, so the field
 * records the key that was pressed. Typing a letter or a symbol still works.
 */
export function captureCanvasKeyInput(input) {
  input.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.code === "Backspace" || event.code === "Delete") {
      event.preventDefault();
      input.value = "";
      return;
    }
    const key = canvasKeyFromCode(event.code);
    if (!key) return;
    event.preventDefault();
    input.value = key;
  });
}
