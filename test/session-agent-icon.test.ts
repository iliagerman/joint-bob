import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/** Returns the source text of a function, from its header to its closing brace at column 0. */
function functionBody(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `${header} not found`);
  const end = source.indexOf("\n}", start);
  assert.notEqual(end, -1, `${header} has no closing brace`);
  return source.slice(start, end);
}

test("the server names the agent that last drove each conversation", async () => {
  const [types, server] = await Promise.all([
    readFile("src/types.ts", "utf8"),
    readFile("src/server.ts", "utf8"),
  ]);

  // The label is prose; the id is what the UI can switch an icon on.
  assert.match(types, /agentId: HarnessId;/);
  const listing = functionBody(server, "async function listProjectSessionsWithReviewState(");
  // A running task overrides the conversation's own harness, exactly as the label does.
  assert.match(listing, /const agentId = config \? config\.engine : session\.harnessId;/);
  assert.match(listing, /\n\s+agentId,/);
});

test("the review inbox carries the agent id alongside the label", async () => {
  const server = await readFile("src/server.ts", "utf8");

  const pending = server.slice(server.indexOf('app.get("/api/reviews/pending"'));
  assert.match(pending.slice(0, 1200), /agentId: session\.agentId,/);
});

test("a conversation row shows a Pi or Claude mark, not only the agent name", async () => {
  const app = await readFile("public/app.js", "utf8");

  assert.match(app, /function agentIcon\(agentId\)/);

  const render = functionBody(app, "function renderSessions() {");
  assert.match(render, /agentIcon\(/);
  assert.match(render, /dataset\.testid = "session-agent-icon"/);
  assert.match(render, /agent\.setAttribute\("aria-label", session\.agentLabel\)/);
  assert.doesNotMatch(render, /document\.createTextNode\(`\$\{session\.agentLabel\}/);
  // The wrapper names the harness; its decorative mark stays out of the accessibility tree.
  const icon = functionBody(app, "function brandIcon(name, className) {");
  assert.match(icon, /setAttribute\("aria-hidden", "true"\)/);
});

test("the review inbox rows carry the same mark as the conversation list", async () => {
  const app = await readFile("public/app.js", "utf8");

  const dialog = functionBody(app, "function renderPendingReviewsDialog() {");
  assert.match(dialog, /agentIcon\(/);
});

test("the mark uses each agent's own colour in both themes", async () => {
  const styles = await readFile("public/styles.css", "utf8");

  assert.match(styles, /\.session-agent-icon\.pi \{[^}]*var\(--accent\)/);
  assert.match(styles, /\.session-agent-icon\.claude \{[^}]*var\(--claude\)/);
});

/**
 * The marks are the real published logos, not lookalikes: Simple Icons' own 24x24 path
 * for each vendor, and pi.dev's own logo geometry rescaled onto the same 24-unit grid.
 */
test("every brand mark is the vendor's real logo", async () => {
  const app = await readFile("public/app.js", "utf8");

  const brands = functionBody(app, "const brandIconPaths = {");
  for (const brand of ["aws", "google", "github", "openai", "claude", "pi", "custom"]) {
    assert.match(brands, new RegExp(`\\n  ${brand}: \\[`), `brandIconPaths is missing ${brand}`);
  }

  // Verbatim opening runs of each published path, so a hand-drawn stand-in cannot pass.
  assert.ok(brands.includes("M6.763 10.036c0 .296.032.535.088.71"), "AWS is not the published mark");
  assert.ok(brands.includes("M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133"), "Google is not the published mark");
  assert.ok(brands.includes("M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385"), "GitHub is not the published mark");
  assert.ok(brands.includes("M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108"), "OpenAI is not the published mark");
  assert.ok(brands.includes("m4.7144 15.9555 4.7174-2.6471"), "Claude is not the published mark");
  // pi.dev's blocky P + dot, scaled from its 800x800 art onto the shared 24-unit grid.
  for (const rect of ["M0 0h18v6H0z", "M0 6h6v18H0z", "M12 6h6v6h-6z", "M6 12h6v6H6z", "M18 12h6v12h-6z"]) {
    assert.ok(brands.includes(rect), `the Pi logo is missing ${rect}`);
  }
});

test("every brand mark is built the same way, so they line up wherever they appear", async () => {
  const app = await readFile("public/app.js", "utf8");

  // One builder, one box, one fill: differing viewBoxes are what make icons sit at
  // different apparent sizes beside each other.
  const builder = functionBody(app, "function brandIcon(name, className) {");
  assert.match(builder, /setAttribute\("viewBox", "0 0 24 24"\)/);
  assert.match(builder, /setAttribute\("fill", "currentColor"\)/);
  for (const wrapper of ["function agentIcon(agentId) {", "function providerIcon(provider) {"]) {
    assert.match(functionBody(app, wrapper), /brandIcon\(/, `${wrapper} does not use the shared builder`);
  }
});

test("the model picker names GPT with the OpenAI mark", async () => {
  const [app, styles] = await Promise.all([
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);

  const dialog = functionBody(app, "function renderModelDialog() {");
  assert.match(dialog, /brandIcon\("openai", "model-group-icon"\)/);
  assert.match(styles, /\.model-group-icon \{/);
});
