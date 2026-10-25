import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { caseFoldKey, isNfc, isSameOrInside, joinInside, normalizeRelativePath, parentKey, PathError, validateRelativePath } from "../src/file-sync/paths.js";

const NFD = "café.txt";
const NFC = "café.txt";

test("normalizeRelativePath returns the NFC key of a valid path", () => {
  assert.equal(normalizeRelativePath("src/a.ts"), "src/a.ts");
  assert.equal(normalizeRelativePath(`docs/${NFD}`), `docs/${NFC}`, "NFD names must become NFC keys");
  assert.equal(normalizeRelativePath("weird\\name:with*chars?"), "weird\\name:with*chars?", "Windows-invalid names stay as they are");
  assert.equal(normalizeRelativePath(".env"), ".env");
  assert.equal(normalizeRelativePath("..hidden/x"), "..hidden/x", "a name starting with two dots is not a parent reference");
});

test("normalizeRelativePath rejects absolute, empty, dot and dot-dot segments", () => {
  for (const input of ["", "/etc/passwd", "a//b", "a/", "./a", "a/./b", "../a", "a/../b", "a/.."]) {
    assert.throws(() => normalizeRelativePath(input), PathError, `${JSON.stringify(input)} must be rejected`);
  }
});

test("normalizeRelativePath rejects NUL and lone surrogates", () => {
  assert.throws(() => normalizeRelativePath("a\0b"), /NUL/);
  assert.throws(() => normalizeRelativePath("a\uD800b"), /Unicode/);
  assert.throws(() => normalizeRelativePath("a\uDC00"), /Unicode/);
  assert.equal(normalizeRelativePath("emoji-😀"), "emoji-😀", "a surrogate pair is a valid character");
});

test("normalizeRelativePath enforces 255-byte names and 4096-byte paths", () => {
  assert.equal(normalizeRelativePath("a".repeat(255)), "a".repeat(255));
  assert.throws(() => normalizeRelativePath("a".repeat(256)), /255 bytes/);
  // é is two bytes in UTF-8: 128 of them is 256 bytes in only 128 characters.
  assert.throws(() => normalizeRelativePath("é".repeat(128)), /255 bytes/);
  const longest = Array.from({ length: 16 }, () => "b".repeat(255)).join("/");
  assert.equal(Buffer.byteLength(longest), 4095);
  assert.equal(normalizeRelativePath(longest), longest);
  assert.throws(() => normalizeRelativePath(`${longest}/cd`), /too long/);
});

test("normalizeRelativePath checks the length after NFC expansion", () => {
  // U+0958 is excluded from composition: NFC turns its 3 bytes into 6.
  const expanding = "क़".repeat(60);
  assert.equal(Buffer.byteLength(expanding), 180);
  assert.equal(Buffer.byteLength(expanding.normalize("NFC")), 360);
  assert.throws(() => normalizeRelativePath(expanding), /255 bytes/);
});

test("validateRelativePath keeps the on-disk spelling", () => {
  assert.equal(validateRelativePath(`dir/${NFD}`), `dir/${NFD}`);
  assert.throws(() => validateRelativePath("../x"), PathError);
});

test("isNfc and caseFoldKey", () => {
  assert.equal(isNfc(NFC), true);
  assert.equal(isNfc(NFD), false);
  assert.equal(caseFoldKey(`Docs/${NFD.toUpperCase()}`), `docs/${NFC}`, "case and normalization variants must share a key");
  assert.equal(caseFoldKey("README.md"), caseFoldKey("readme.MD"));
});

test("joinInside stays under the root", () => {
  const root = path.resolve("/srv/share");
  assert.equal(joinInside(root, "a/b.txt"), path.join(root, "a", "b.txt"));
  assert.equal(joinInside(root, ""), root, "the empty path is the root itself");
  assert.equal(joinInside(root, "..x"), path.join(root, "..x"), "a dot-dot prefixed name is still inside");
  assert.throws(() => joinInside(root, "../escape"), PathError);
  assert.throws(() => joinInside(root, "/abs"), PathError);
  assert.throws(() => joinInside("relative/root", "a"), /absolute/);
});

test("parentKey and isSameOrInside", () => {
  assert.equal(parentKey("a.txt"), "");
  assert.equal(parentKey("a/b/c.txt"), "a/b");
  assert.equal(isSameOrInside("a/b/c", "a/b"), true);
  assert.equal(isSameOrInside("a/b", "a/b"), true);
  assert.equal(isSameOrInside("a/bc", "a/b"), false, "a sibling sharing the prefix text is not inside");
  assert.equal(isSameOrInside("anything", ""), true);
});
