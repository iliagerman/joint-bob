import path from "node:path";

/* Index keys are share-relative, "/"-separated and NFC. Every path that comes from a peer or a
   watcher event passes through here before it touches the index or the disk. Windows-invalid
   names are allowed: no Windows node syncs these trees. */

export const MAX_PATH_BYTES = 4096;
export const MAX_SEGMENT_BYTES = 255;

export class PathError extends Error {
  constructor(message: string, readonly path: string) { super(message); }
}

// A lone surrogate cannot be written as UTF-8, so no file on disk can have that name.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Checks a relative path without changing it (on-disk spellings may be NFD); returns it. */
export function validateRelativePath(input: string): string {
  if (typeof input !== "string") throw new PathError("Path must be a string", String(input));
  if (input === "") throw new PathError("Path is empty", input);
  if (input.includes("\0")) throw new PathError("Path contains a NUL byte", input);
  if (LONE_SURROGATE.test(input)) throw new PathError("Path is not valid Unicode", input);
  if (input.startsWith("/")) throw new PathError("Path must be relative", input);
  if (Buffer.byteLength(input, "utf8") > MAX_PATH_BYTES) throw new PathError("Path is too long", input);
  for (const segment of input.split("/")) {
    if (segment === "" || segment === "." || segment === "..") throw new PathError("Path has an empty, '.' or '..' segment", input);
    if (Buffer.byteLength(segment, "utf8") > MAX_SEGMENT_BYTES) throw new PathError("Path has a name longer than 255 bytes", input);
  }
  return input;
}

/** The index key for a relative path: validated and NFC. Throws PathError. */
export function normalizeRelativePath(input: string): string {
  validateRelativePath(input);
  const nfc = input.normalize("NFC");
  // NFC can change the byte length (composition exclusions expand), so the stored form is checked too.
  return nfc === input ? nfc : validateRelativePath(nfc);
}

export function isNfc(name: string): boolean {
  return name === name.normalize("NFC");
}

/** Case-insensitive identity of a path (APFS treats these as one file). */
export function caseFoldKey(relative: string): string {
  return relative.normalize("NFC").toLowerCase().normalize("NFC");
}

/** Absolute path of `relative` under `root`; "" is the root itself. Throws when it would leave the root. */
export function joinInside(root: string, relative: string): string {
  if (!path.isAbsolute(root)) throw new PathError("Share root must be absolute", root);
  const base = path.resolve(root);
  if (relative === "") return base;
  validateRelativePath(relative);
  const full = path.join(base, relative);
  const inside = path.relative(base, full);
  if (!inside || inside.split(path.sep)[0] === ".." || path.isAbsolute(inside)) throw new PathError("Path leaves the share root", relative);
  return full;
}

/** The `parent` column: the directory key, "" for children of the root. */
export function parentKey(relative: string): string {
  const slash = relative.lastIndexOf("/");
  return slash < 0 ? "" : relative.slice(0, slash);
}

/** True for `prefix` itself and anything below it; "" covers the whole share. */
export function isSameOrInside(relative: string, prefix: string): boolean {
  return prefix === "" || relative === prefix || relative.startsWith(`${prefix}/`);
}
