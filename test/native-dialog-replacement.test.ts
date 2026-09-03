import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("the frontend never falls back to a browser confirm, alert or prompt box", async () => {
  const names = (await readdir("public")).filter((name) => name.endsWith(".js"));
  assert.ok(names.length > 0, "Missing frontend scripts");
  for (const name of names) {
    const source = await readFile(`public/${name}`, "utf8");
    const code = source.replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /(?<![.\w$])(?:window\.)?(?:confirm|alert|prompt)\s*\(/, `public/${name} still opens a browser dialog`);
  }
});

test("the app owns a themed confirm dialog wired to a promise helper", async () => {
  const [html, app, styles] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);
  const start = html.indexOf('<dialog id="confirmDialog"');
  const end = html.indexOf("</dialog>", start);
  assert.ok(start >= 0 && end >= 0, "Missing confirm dialog");
  const dialog = html.slice(start, end);

  assert.match(dialog, /<form method="dialog" class="dialog-card confirm-card">/);
  assert.match(dialog, /id="confirmTitle"/);
  assert.match(dialog, /id="confirmMessage"/);
  assert.match(dialog, /id="confirmCancelButton"[^>]*data-testid="confirm-cancel-button"/);
  assert.match(dialog, /type="submit" value="confirm" id="confirmAcceptButton"[^>]*data-testid="confirm-accept-button"/);

  assert.match(app, /elements\.confirmCancelButton\.addEventListener\("click", \(\) => elements\.confirmDialog\.close\("cancel"\)\)/);
  assert.match(app, /function confirmAction\(\{[\s\S]*?dialog\.showModal\(\)[\s\S]*?resolve\(dialog\.returnValue === "confirm"\)/);
  assert.match(styles, /\.primary\.destructive \{[^}]*background: var\(--danger\)/);
});

test("destination pickers use the app's choice dialog instead of a text prompt", async () => {
  const [html, app] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
  ]);
  const start = html.indexOf('<dialog id="choiceDialog"');
  const end = html.indexOf("</dialog>", start);
  assert.ok(start >= 0 && end >= 0, "Missing choice dialog");
  const dialog = html.slice(start, end);

  assert.match(dialog, /id="choiceList"[^>]*role="radiogroup"/);
  assert.match(dialog, /id="choiceCancelButton"[^>]*data-testid="choice-cancel-button"/);
  assert.match(dialog, /type="submit" value="confirm" id="choiceAcceptButton"[^>]*data-testid="choice-accept-button"/);

  assert.match(app, /function chooseOption\(\{[\s\S]*?input\.type = "radio"[\s\S]*?resolve\(elements\.choiceList\.querySelector\("input:checked"\)\?\.value \?\? null\)/);
  assert.match(app, /async function handoffTask\(task\)[\s\S]*?await chooseOption\(\{/);
});

test("every destructive action asks through confirmAction before it calls the api", async () => {
  const app = await readFile("public/app.js", "utf8");
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
