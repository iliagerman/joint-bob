import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("project and conversation requests expose accessible loading bars", async () => {
  const [html, app, styles] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);

  assert.match(html, /id="projectsLoading"[^>]*role="progressbar"[^>]*aria-label="Loading projects"/);
  assert.match(html, /id="sessionsLoading"[^>]*role="progressbar"[^>]*aria-label="Loading conversations"[^>]*hidden/);
  assert.match(app, /setListLoading\("projects", true\)/);
  assert.match(app, /setListLoading\("sessions", true\)/);
  assert.match(app, /setMobileView\("sessions"\);[\s\S]*api\(`\/api\/projects\/\$\{encodeURIComponent\(projectId\)\}\/sessions`\)/);
  assert.match(styles, /@keyframes beam-head/);
  assert.match(styles, /prefers-reduced-motion: reduce/);
});
