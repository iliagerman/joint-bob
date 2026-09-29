import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { appSource } from "./source.js";

/** Returns the source text of a function, from its header to its closing brace at column 0. */
function functionBody(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `${header} not found`);
  const end = source.indexOf("\n}", start);
  assert.notEqual(end, -1, `${header} has no closing brace`);
  return source.slice(start, end);
}

/**
 * The marks are the real published logos, not lookalikes: vendor paths from their
 * published assets, including Kiro's bundled kiricons package.
 */
test("every brand mark is the vendor's real logo", async () => {
  const app = await appSource();

  const brands = functionBody(app, "const brandIconPaths = {");
  for (const brand of ["aws", "google", "github", "openai", "claude", "pi", "kiro", "custom"]) {
    assert.match(brands, new RegExp(`\\n  ${brand}: \\[`), `brandIconPaths is missing ${brand}`);
  }

  // Verbatim opening runs of each published path, so a hand-drawn stand-in cannot pass.
  assert.ok(app.includes("M6.763 10.036c0 .296.032.535.088.71"), "AWS is not the published mark");
  assert.match(brands, /\n  aws: \[awsMark\]/);
  assert.doesNotMatch(brands, /\n  kiro: \[awsMark\]/);
  assert.ok(brands.includes("M8.74842 1C10.9904 0.997658 13.2522 2.35131"), "Kiro is not the official ghost mark");
  assert.ok(brands.includes("M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133"), "Google is not the published mark");
  assert.ok(brands.includes("M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385"), "GitHub is not the published mark");
  assert.ok(brands.includes("M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108"), "OpenAI is not the published mark");
  assert.ok(brands.includes("m4.7144 15.9555 4.7174-2.6471"), "Claude is not the published mark");
  // pi.dev's blocky P + dot, scaled from its 800x800 art onto the shared 24-unit grid.
  for (const rect of ["M0 0h18v6H0z", "M0 6h6v18H0z", "M12 6h6v6h-6z", "M6 12h6v6H6z", "M18 12h6v12h-6z"]) {
    assert.ok(brands.includes(rect), `the Pi logo is missing ${rect}`);
  }
});

/**
 * Every conversation row draws its harness's mark by id, and the builder throws on an id
 * it does not know, so a harness without a mark takes the whole list down with it.
 */
test("every registered harness has a brand mark", async () => {
  const modules = (await readdir("src/harnesses")).filter((name) => name.endsWith(".harness.ts"));
  const [app, ...harnesses] = await Promise.all([
    appSource(),
    ...modules.map((name) => readFile(`src/harnesses/${name}`, "utf8")),
  ]);
  assert.ok(harnesses.length >= 3, "expected the pi, claude and kiro harness modules");

  const brands = functionBody(app, "const brandIconPaths = {");
  for (const harness of harnesses) {
    const id = /\bid: "([^"]+)"/.exec(harness)?.[1];
    assert.ok(id, "harness module has no id");
    assert.match(brands, new RegExp(`\\n  ${id}: \\[`), `brandIconPaths is missing the ${id} harness`);
  }
});
