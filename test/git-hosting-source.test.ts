import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Git view exposes list-first PR and pipeline tabs with mobile-visible navigation", async () => {
  const [markup, source, styles] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app/git-hosting.js", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);
  assert.match(markup, /data-testid="git-review-tab-pulls"/);
  assert.match(markup, /data-testid="git-review-tab-pipelines"/);
  assert.match(source, /All pull requests/);
  assert.match(source, /All pipeline runs/);
  assert.match(source, /renderList\(\);[\s\S]*async function openDetail/);
  assert.match(source, /\.git-hosting-graph-body/);
  assert.match(styles, /\.git-review-tab:nth-child\(n\+4\) \{ grid-column: span 3; \}/);
  assert.match(styles, /\.git-hosting-graph-body \{ display: grid; gap: 22px; \}/);
});
