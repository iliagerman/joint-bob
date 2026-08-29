import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/** Returns the markup of one settings tab panel, from its opening tag to its closing </section>. */
function settingsPanel(html: string, name: string): string {
  const start = html.indexOf(`<section class="settings-panel" id="settingsPanel-${name}"`);
  assert.notEqual(start, -1, `settingsPanel-${name} not found`);
  const end = html.indexOf("</section>", start);
  assert.notEqual(end, -1, `settingsPanel-${name} has no closing tag`);
  return html.slice(start, end);
}

test("GitHub groups live in the Projects tab, not the Secrets tab", async () => {
  const html = await readFile("public/index.html", "utf8");

  const projects = settingsPanel(html, "projects");
  assert.match(projects, /id="githubGroupList"/);
  assert.match(projects, /id="githubGroupAddButton"/);
  assert.match(projects, /id="githubSyncButton"/);
  assert.match(projects, /<legend>GitHub groups<\/legend>/);

  const github = settingsPanel(html, "github");
  assert.doesNotMatch(github, /id="githubGroupList"/);
  assert.doesNotMatch(github, /id="githubGroupAddButton"/);
  assert.doesNotMatch(github, /id="githubSyncButton"/);
  // The Secrets tab keeps only node-local secret accounts.
  assert.match(github, /id="secretAccountList"/);
  assert.match(github, /id="secretAccountAddButton"/);
});

test("focused controls in a settings panel are not clipped by its scroll box", async () => {
  const styles = await readFile("public/styles.css", "utf8");

  // The focus ring is a 3px box-shadow plus a 2px outline at 2px offset, drawn outside the
  // control. A scroll container with no padding cuts it off at the left and right edges.
  const panel = /\.settings-panel \{[^}]*\}/.exec(styles)?.[0] ?? "";
  assert.match(panel, /overflow-y: auto/);
  const padding = /padding: (\d+)px/.exec(panel);
  assert.ok(padding, ".settings-panel must reserve padding for the focus ring");
  assert.ok(Number(padding[1]) >= 5, `.settings-panel padding is ${padding[1]}px, needs >= 5px`);
});

test("Recents and More are icon buttons with accessible names", async () => {
  const html = await readFile("public/index.html", "utf8");

  const recents = /<button[^>]*id="chatRecentSessionsButton"[\s\S]*?<\/button>/.exec(html)?.[0] ?? "";
  assert.match(recents, /class="[^"]*icon-button[^"]*"/);
  assert.match(recents, /aria-label="Recent conversations"/);
  assert.match(recents, /<svg[^>]*aria-hidden="true"/);
  assert.doesNotMatch(recents, />Recents</);

  const more = /<summary[^>]*data-testid="chat-more-button"[\s\S]*?<\/summary>/.exec(html)?.[0] ?? "";
  assert.match(more, /class="[^"]*icon-button[^"]*"/);
  assert.match(more, /aria-label="More chat actions"/);
  assert.match(more, /<svg[^>]*aria-hidden="true"/);
  assert.doesNotMatch(more, />More</);
});

test("the toolbar icon buttons are sized and centred", async () => {
  const styles = await readFile("public/styles.css", "utf8");

  assert.match(styles, /\.chat-toolbar-icon \{[^}]*width: 17px;[^}]*height: 17px;/);
  // On mobile the More trigger is a <summary>, which needs its own centring.
  assert.match(styles, /\.chat-more > summary \{[^}]*justify-content: center;/);
});
