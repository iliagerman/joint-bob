import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { appSource } from "./source.js";

test("the frontend never falls back to a browser confirm, alert or prompt box", async () => {
  const paths = (await Promise.all(["public", "public/app"].map(async (directory) =>
    (await readdir(directory)).filter((name) => name.endsWith(".js")).map((name) => `${directory}/${name}`),
  ))).flat();
  assert.ok(paths.length > 0, "Missing frontend scripts");
  for (const filePath of paths) {
    const source = await readFile(filePath, "utf8");
    const code = source.replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /(?<![.\w$])(?:window\.)?(?:confirm|alert|prompt)\s*\(/, `${filePath} still opens a browser dialog`);
  }
});

test("every destructive action asks through confirmAction before it calls the api", async () => {
  const app = await appSource();
  for (const owner of [
    "async function removeProject(project)",
    "async function removeSessionFromRow(session, sessionActive)",
    "async function archiveTask(task)",
    "async function mergeTask(task)",
    "async function deleteTaskFromCard(task)",
    "async function deleteSecretAccount(account)",
    "async function attemptCloseFileEditor()",
  ]) {
    const start = app.indexOf(owner);
    assert.ok(start >= 0, `Missing ${owner}`);
    const body = app.slice(start, app.indexOf("\n}", start));
    assert.match(body, /await confirmAction\(\{/, `${owner} does not ask before acting`);
  }
});
