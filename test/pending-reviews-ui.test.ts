import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the projects header swaps the add button for a pending reviews button", async () => {
  const [html, styles] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);
  const actionsStart = html.indexOf('<div class="project-actions">');
  assert.ok(actionsStart >= 0, "Missing project actions bar");
  const actions = html.slice(actionsStart, html.indexOf("</header>", actionsStart));

  assert.doesNotMatch(actions, /id="newProjectButton"/);
  assert.match(actions, /id="pendingReviewsButton"[^>]*data-pending-reviews-open/);
  assert.match(actions, /data-testid="pending-reviews-open-button"/);
  assert.match(actions, /id="pendingReviewsBadge"/);

  const searchRowStart = html.indexOf('<div class="project-search-row">');
  assert.ok(searchRowStart >= 0, "Missing project search row");
  const searchRow = html.slice(searchRowStart, html.indexOf("</div>", searchRowStart));
  assert.match(searchRow, /id="projectSearchInput"/);
  assert.match(searchRow, /id="newProjectButton"[^>]*data-testid="project-create-button"/);

  assert.match(styles, /\.project-search-row\s*\{[^}]*display:\s*flex/);
  assert.match(styles, /\.project-search-row\s+\.search-shell\s*\{[^}]*margin:\s*0/);
});

test("the bottom navigation gains a reviews button that opens the same dialog", async () => {
  const [html, styles, app] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/styles.css", "utf8"),
    readFile("public/app.js", "utf8"),
  ]);
  const navStart = html.indexOf('<nav class="mobile-nav"');
  assert.ok(navStart >= 0, "Missing bottom navigation");
  const nav = html.slice(navStart, html.indexOf("</nav>", navStart));

  assert.match(nav, /id="navReviewsButton"/);
  assert.match(nav, /data-testid="nav-reviews-button"/);
  assert.match(nav, /id="navPendingReviewsBadge"/);
  assert.match(nav, /data-pending-reviews-open/);
  assert.match(styles, /\.mobile-nav\s*\{[^}]*grid-template-columns:\s*repeat\(5,\s*1fr\)/);
  assert.match(app, /document\.querySelectorAll\("\[data-pending-reviews-open\]"\)/);
});

test("the pending reviews dialog lists every project and marks them all read", async () => {
  const [html, app] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
  ]);
  const dialogStart = html.indexOf('<dialog id="pendingReviewsDialog"');
  assert.ok(dialogStart >= 0, "Missing pending reviews dialog");
  const dialog = html.slice(dialogStart, html.indexOf("</dialog>", dialogStart));

  assert.match(dialog, /id="pendingReviewsList"/);
  assert.match(dialog, /id="markAllPendingReviewedButton"[^>]*data-testid="pending-reviews-mark-all-button"/);
  assert.match(dialog, /id="closePendingReviewsButton"/);

  assert.match(app, /api\("\/api\/reviews\/pending"\)/);
  assert.match(app, /function renderPendingReviewsBadge\(\)/);
  assert.match(app, /async function markAllPendingReviewed\(\)/);
  assert.match(app, /sessions\/reviewed-all/);
});

test("scrolling lists keep full-height rows instead of squashing them", async () => {
  const styles = await readFile("public/styles.css", "utf8");
  // A capped grid shrinks its auto rows once the content overflows, and rows that opt out of
  // the 56px floor collapse to a clipped sliver. max-content pins each row to its own height.
  for (const list of [".pending-reviews-list", ".recent-sessions-list"]) {
    const rule = styles.match(new RegExp(`\\${list}\\s*\\{[^}]*\\}`));
    assert.ok(rule, `Missing ${list} rule`);
    assert.match(rule[0], /max-height:/);
    assert.match(rule[0], /grid-auto-rows:\s*max-content/);
  }
  // The row title is one line with the full text in the tooltip, so rows stay a uniform height.
  assert.match(
    styles,
    /\.pending-reviews-list \.session-card strong\s*\{[^}]*white-space:\s*nowrap[^}]*text-overflow:\s*ellipsis/,
  );
  assert.match(styles, /\.pending-reviews-list \.session-card span\s*\{[^}]*-webkit-line-clamp:\s*1/);
});
