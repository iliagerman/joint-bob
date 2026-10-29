// Small pieces shared by the webhook detail tabs (files, skills, memory).
import { makeNode } from "./relay-ui.js";

export const byId = (id) => document.getElementById(id);
export const errorText = (error) => error?.message || "Something went wrong";

const MAX_BYTES = 4 * 1024 * 1024;

/** A file's bytes as base64, refusing anything over the 4 MiB the server accepts. */
export async function encodeFile(file) {
  if (file.size > MAX_BYTES) throw new Error(`${file.name} exceeds the 4 MiB limit`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

export function saveBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** A row of mutually exclusive buttons. `options` is `[{ value, label, testid }]`. */
export function makeSegmented(options, selected, onSelect) {
  const group = makeNode("div", "webhooks-seg");
  group.setAttribute("role", "group");
  for (const option of options) {
    const button = makeNode("button", "", option.label);
    button.type = "button";
    button.dataset.testid = option.testid;
    button.setAttribute("aria-pressed", String(option.value === selected));
    button.addEventListener("click", () => {
      for (const other of group.children) other.setAttribute("aria-pressed", String(other === button));
      onSelect(option.value);
    });
    group.append(button);
  }
  return group;
}
