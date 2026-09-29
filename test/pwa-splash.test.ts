import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SPLASH_INK = "#141618";

// Android paints its launch splash from the manifest, which has no dark variant, so the only way
// both splashes agree in every phone theme is to pin them both to the icon tile's own ink.
test("the launch splash is dark whatever the phone theme is", async () => {
  const manifest = JSON.parse(await readFile("public/manifest.webmanifest", "utf8"));
  assert.equal(manifest.background_color, SPLASH_INK);
  // The status bar sits on top of that splash until the page's own theme-color meta takes over.
  assert.equal(manifest.theme_color, SPLASH_INK);
});

// A padded icon shows its padding as corners on any launcher that does not crop to a circle, so
// the tile stays full-bleed: on a splash of the same ink the crop shape is invisible anyway.
test("the app icon is the full-bleed tile with no padded variant", async () => {
  const icons = JSON.parse(await readFile("public/manifest.webmanifest", "utf8")).icons;
  assert.equal(icons.filter((icon: { src: string }) => icon.src.includes("maskable")).length, 0);
  for (const size of [192, 512]) {
    const icon = icons.find((entry: { src: string }) => entry.src === `/icon-${size}.png`);
    assert.ok(icon, `/icon-${size}.png declared`);
    assert.equal(icon.purpose, "any maskable");
  }
});
