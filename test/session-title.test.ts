import assert from "node:assert/strict";
import test from "node:test";
import { titleCase } from "../src/session-title.js";

test("generated titles capitalise each word and keep known abbreviations in capitals", () => {
  assert.equal(titleCase("Fixing mobile ux"), "Fixing Mobile UX");
  assert.equal(titleCase("merging agents"), "Merging Agents");
  assert.equal(titleCase("check the api and url handling"), "Check The API And URL Handling");
  assert.equal(titleCase("Already Fine"), "Already Fine");
});
