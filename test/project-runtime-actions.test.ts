import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { appSource, serverSource } from "./source.js";

test("project loading does not wait for runtime or peer status discovery", async () => {
  const [app, server] = await Promise.all([
    appSource(),
    serverSource(),
  ]);

  assert.match(app, /void loadHarnesses\(\)\.catch/);
  assert.match(app, /api\("\/api\/projects\?syncStatus=false"\)/);
  const loader = app.match(/async function loadProjects\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.doesNotMatch(loader, /loadModels\(\)/);
  assert.ok(loader.indexOf('api("/api/projects?syncStatus=false")') < loader.indexOf("void loadHarnesses()"));
  assert.match(app, /void loadSessionNodes\(projectId\)\.catch/);
  assert.match(server, /Promise\.all\(\(await listClusterPeers\(\)\)\.map/);
});

test("harness selection becomes the draft used when execution node changes", async () => {
  const app = await appSource();
  const handler = app.match(/elements\.chatHarnessSelect\.addEventListener\("change", \(\) => \{([\s\S]*?)\n\}\);/)?.[1] ?? "";

  assert.match(handler, /state\.engine = harness\.id/);
  assert.match(handler, /state\.activeSessionPath = harness\.newSessionPath/);
  assert.match(handler, /state\.activeSessionId = null/);
  assert.match(handler, /sendSocket\(\{ type: "setEngine", engine: harness\.id \}\)/);
});

test("chat exposes an embedded terminal on the selected project and node", async () => {
  const [html, app, server] = await Promise.all([
    readFile("public/index.html", "utf8"),
    appSource(),
    serverSource(),
  ]);

  assert.match(html, /id="openTerminalButton"[^>]*data-testid="chat-open-terminal-button"/);
  assert.match(html, /id="terminalDialog"[^>]*data-testid="terminal-dialog"/);
  assert.match(html, /id="terminalHost"[^>]*data-testid="terminal-output"/);
  assert.match(html, /src="\/vendor\/xterm\/xterm\.js"/);
  assert.match(html, /href="\/vendor\/xterm\/xterm\.css"/);
  assert.match(app, /url\.searchParams\.set\("mode", "terminal"\)/);
  assert.match(app, /type: "terminalInput", data/);
  assert.match(app, /type: "terminalResize", cols/);
  assert.match(app, /new window\.Terminal\(/);
  assert.match(server, /url\.searchParams\.get\("mode"\) === "terminal"/);
  assert.doesNotMatch(server, /app\.post\("\/api\/projects\/:projectId\/terminal"/);
  assert.doesNotMatch(server, /app\.post\("\/api\/cluster\/projects\/terminal"/);
});

test("the security policy leaves room for the styles xterm writes at runtime", async () => {
  const server = await serverSource();
  const policy = server.match(/"Content-Security-Policy", `([^`]+)`/)?.[1] ?? "";

  // xterm re-writes a <style> element on every resize and paints ANSI colours
  // through per-cell style attributes. Neither can carry a nonce or a stable
  // hash, so tightening these two directives silently breaks the terminal.
  assert.match(policy, /style-src-elem \$\{inlineStyle\}/);
  assert.match(policy, /style-src-attr \$\{inlineStyle\}/);
  assert.match(server, /const inlineStyle = "'self' 'unsafe-inline'"/);
  // Scripts stay locked down: inline styles are the only relaxation.
  assert.match(policy, /script-src 'self'/);
  assert.doesNotMatch(policy, /script-src[^;]*unsafe-inline/);
});
