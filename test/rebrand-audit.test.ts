import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const oldBrand = /Master Bob|Pi Mobile Web|pi-mobile-console/i;

test("public product surfaces use Joint Bob", async () => {
  for (const path of ["public/index.html", "public/app.js", "public/styles.css", "public/manifest.webmanifest", "public/icon.svg", "README.md"]) {
    const contents = await readFile(path, "utf8");
    assert.doesNotMatch(contents, oldBrand, path);
  }
  assert.match(await readFile("public/icon.svg", "utf8"), /aria-label="Joint Bob icon"/);
});

test("every PWA icon has its declared dimensions", async () => {
  for (const [path, expected] of [["public/icon-192.png", 192], ["public/icon-512.png", 512]] as const) {
    const png = await readFile(path);
    assert.equal(png.readUInt32BE(16), expected, `${path} width`);
    assert.equal(png.readUInt32BE(20), expected, `${path} height`);
  }
});

test("runtime-facing text and new paths use Joint Bob", async () => {
  const [server, store, worktrees, push] = await Promise.all([
    readFile("src/server.ts", "utf8"),
    readFile("src/store.ts", "utf8"),
    readFile("src/worktrees.ts", "utf8"),
    readFile("src/push.ts", "utf8"),
  ]);
  for (const contents of [server, store, worktrees, push]) assert.doesNotMatch(contents, oldBrand);
  assert.match(server, /\.joint-bob-attachments/);
  assert.match(worktrees, /\.joint-bob-worktrees/);
  assert.match(store, /joint-bob-\$\{slug/);
  assert.match(push, /mailto:joint-bob@localhost/);
});
