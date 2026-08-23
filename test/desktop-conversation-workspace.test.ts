import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("conversation search composes with status filtering", async () => {
  const [html, app] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
  ]);

  assert.match(html, /id="sessionSearchInput"[^>]*type="search"[^>]*data-testid="conversation-list-search-input"/);
  assert.match(app, /sessionSearchInput: document\.querySelector\("#sessionSearchInput"\)/);
  assert.match(app, /function filteredSessions\(\)[\s\S]*sessionSearchInput\.value[\s\S]*state\.chatFilter/);
  assert.match(app, /sessionSearchInput\.addEventListener\("input", \(\) => renderSessions\(\)\)/);
});

test("desktop chat uses available width and project header actions do not cover title", async () => {
  const styles = await readFile("public/styles.css", "utf8");

  assert.doesNotMatch(styles, /#projectsPanel \.panel-bar[^}]*flex-wrap:\s*wrap/);
  assert.match(styles, /\.project-actions \{[^}]*flex:\s*0 0 auto/);
  assert.match(styles, /\.brand \{[^}]*flex:\s*1[^}]*min-width:\s*0/);
  assert.match(styles, /\.brand-copy strong, \.brand-copy span \{[^}]*text-overflow:\s*ellipsis/);
  assert.match(styles, /@media \(min-width: 1024px\)[\s\S]*\.message\.assistant[\s\S]*width:\s*100%[\s\S]*max-width:\s*100%/);
  assert.match(styles, /@media \(min-width: 1024px\)[\s\S]*textarea[^}]*max-height:\s*min\(40dvh, 360px\)/);
});

test("newly opened sessions can react immediately to synced file changes", async () => {
  const server = await readFile("src/server.ts", "utf8");

  assert.match(server, /lastLocalEventAt:\s*0,/);
  assert.doesNotMatch(server, /lastLocalEventAt:\s*Date\.now\(\),/);
});
