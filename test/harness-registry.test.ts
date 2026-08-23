import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { harnessForSessionPath, listHarnesses } from "../src/harnesses.js";

test("harness registry exposes adapters instead of UI-specific engine checks", () => {
  const harnesses = listHarnesses();

  assert.deepEqual(harnesses.map(({ id, label, newSessionPath }) => ({ id, label, newSessionPath })), [
    { id: "pi", label: "Pi", newSessionPath: "new" },
    { id: "claude", label: "Claude", newSessionPath: "claude:new" },
  ]);
  for (const harness of harnesses) {
    assert.equal(typeof harness.listSessions, "function");
    assert.equal(typeof harness.loadMessages, "function");
  }
  assert.equal(harnessForSessionPath("/tmp/session.jsonl").id, "pi");
  assert.equal(harnessForSessionPath("claude:/tmp/session.jsonl").id, "claude");
});

test("chat provides independent harness and session selectors", async () => {
  const [html, app] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
  ]);

  assert.match(html, /id="chatHarnessSelect"[^>]*aria-label="Harness"[^>]*data-testid="chat-harness-select"/);
  assert.match(html, /id="chatSessionSelect"[^>]*aria-label="Session"[^>]*data-testid="chat-session-select"/);
  assert.match(app, /function renderChatSessionControls\(\)/);
  assert.match(app, /chatSessionSelect\.addEventListener\("change"/);
  assert.match(app, /openSession\(session\.path/);
  assert.match(app, /api\("\/api\/harnesses"\)/);
});

test("Pi resume overrides a synchronized session's source cwd", async () => {
  const source = await readFile("src/pi-service.ts", "utf8");

  assert.match(source, /SessionManager\.open\(options\.sessionPath, piSessionPath\(\), options\.cwd\)/);
});
