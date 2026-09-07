import { canvasKeyFromCode, isCanvasModifierKey } from "../canvas-layout.js";

/**
 * Turns a text field into a "press the key you want" box. Enter and the punctuation
 * keys either type nothing or type something a plain field would mangle, so the field
 * records the key that was pressed. Typing a letter or a symbol still works.
 */
export function captureCanvasKeyInput(input) {
  input.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || isCanvasModifierKey(event)) return;
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
