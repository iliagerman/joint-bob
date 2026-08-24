import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("board tasks save without a description and report blank titles", async () => {
  const [page, app, server] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("src/server.ts", "utf8"),
  ]);

  assert.match(page, /Task description \(optional\)/);
  assert.doesNotMatch(page, /id="taskDescriptionInput"[^>]*\brequired\b/);
  assert.match(server, /const taskCreateSchema = z\.object\(\{\s*title:[^\n]+\n\s*description: z\.string\(\)\.trim\(\)\.max\(4000\)/);
  assert.match(app, /if \(!payload\.title\) throw new Error\("Task title is required"\)/);
});
