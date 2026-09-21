import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Source assertions keep the routing UI wiring from silently disappearing; the
// behaviour itself is covered by test/routing-dispatch.test.ts and the browser suite.
test("prompt routing UI wiring stays connected", async () => {
  const [socket, transcript, panel, index, worker] = await Promise.all([
    readFile("public/app/socket.js", "utf8"),
    readFile("public/app/chat-transcript.js", "utf8"),
    readFile("public/app/cluster-panel.js", "utf8"),
    readFile("public/index.html", "utf8"),
    readFile("public/sw.js", "utf8"),
  ]);
  assert.match(socket, /payload\.type === "promptRouted"/, "the socket must forward promptRouted to the transcript");
  assert.match(socket, /markPromptRouted/);
  assert.match(transcript, /export function markPromptRouted/, "the transcript must render the routing note");
  assert.match(panel, /\/api\/cluster\/routing/, "the cluster panel must load and save the routing policy");
  assert.match(panel, /routingFormValue/, "the panel must submit the full policy shape");
  for (const testid of ["routing-enabled", "routing-classifier", "routing-cadence", "routing-confidence", "routing-harness-tables", "routing-save-button", "routing-clear-button"]) {
    assert.ok(index.includes(`data-testid="${testid}"`), `index.html must carry ${testid}`);
  }
  assert.match(worker, /const CACHE_NAME = "joint-bob-v\d+";/);
});
