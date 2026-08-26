import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("project loading does not wait for runtime or peer status discovery", async () => {
  const [app, server] = await Promise.all([
    readFile("public/app.js", "utf8"),
    readFile("src/server.ts", "utf8"),
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
  const app = await readFile("public/app.js", "utf8");
  const handler = app.match(/elements\.chatHarnessSelect\.addEventListener\("change", \(\) => \{([\s\S]*?)\n\}\);/)?.[1] ?? "";

  assert.match(handler, /state\.engine = harness\.id/);
  assert.match(handler, /state\.activeSessionPath = harness\.newSessionPath/);
  assert.match(handler, /state\.activeSessionId = null/);
  assert.match(handler, /sendSocket\(\{ type: "setEngine", engine: harness\.id \}\)/);
});

test("chat exposes an embedded terminal on the selected project and node", async () => {
  const [html, app, server] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("src/server.ts", "utf8"),
  ]);

  assert.match(html, /id="openTerminalButton"[^>]*data-testid="chat-open-terminal-button"/);
  assert.match(html, /id="terminalDialog"[^>]*data-testid="terminal-dialog"/);
  assert.match(html, /id="terminalOutput"[^>]*data-testid="terminal-output"/);
  assert.match(html, /id="terminalInput"[^>]*data-testid="terminal-input"/);
  assert.match(app, /url\.searchParams\.set\("mode", "terminal"\)/);
  assert.match(app, /type: "terminalInput", data:/);
  assert.match(server, /url\.searchParams\.get\("mode"\) === "terminal"/);
  assert.doesNotMatch(server, /app\.post\("\/api\/projects\/:projectId\/terminal"/);
  assert.doesNotMatch(server, /app\.post\("\/api\/cluster\/projects\/terminal"/);
});
