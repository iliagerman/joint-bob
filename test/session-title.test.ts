import assert from "node:assert/strict";
import test from "node:test";
import { titleCase } from "../src/session-title.js";

test("titles read in title case with known abbreviations in capitals", () => {
  assert.equal(titleCase("Fixing mobile ux"), "Fixing Mobile UX");
  assert.equal(titleCase("error saving settigngs"), "Error Saving Settigngs");
  assert.equal(titleCase("check the api and url handling"), "Check The API And URL Handling");
  assert.equal(titleCase("[Claude] Scroll follow reference"), "[Claude] Scroll Follow Reference");
});

test("title case keeps apostrophes, mixed-case words and other scripts intact", () => {
  assert.equal(titleCase("don't stop the iOS build"), "Don't Stop The iOS Build");
  assert.equal(titleCase("GitHub sync"), "GitHub Sync");
  assert.equal(titleCase("été release"), "Été Release");
  assert.equal(titleCase("תיקון באג"), "תיקון באג");
});
