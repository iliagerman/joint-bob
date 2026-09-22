import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Source assertions keep the routing UI wiring from silently disappearing; the
// behaviour itself is covered by test/routing-dispatch.test.ts and the browser suite.
test("prompt routing UI wiring stays connected", async () => {
  const [socket, transcript, panel, index, worker, controls, dialogs, settings] = await Promise.all([
    readFile("public/app/socket.js", "utf8"),
    readFile("public/app/chat-transcript.js", "utf8"),
    readFile("public/app/cluster-panel.js", "utf8"),
    readFile("public/index.html", "utf8"),
    readFile("public/sw.js", "utf8"),
    readFile("public/app/chat-controls.js", "utf8"),
    readFile("public/app/composer-dialogs.js", "utf8"),
    readFile("public/app/settings.js", "utf8"),
  ]);
  assert.match(socket, /payload\.type === "promptRouted"/, "the socket must forward promptRouted to the transcript");
  assert.match(socket, /markPromptRouted/);
  assert.match(socket, /payload\.type === "routingMode"/, "the socket must forward routingMode");
  assert.match(transcript, /export function markPromptRouted/, "the transcript must render the routing note");
  assert.match(panel, /\/api\/cluster\/routing/, "the cluster panel must load and save the routing policy");
  assert.match(panel, /routingFormValue/, "the panel must submit the full policy shape");
  assert.match(panel, /defaultPolicy/, "an untouched policy prefills the default pairs");
  assert.match(panel, /routing-description/, "each configured option carries a classifier description");
  assert.match(dialogs, /bob-auto/, "the model dialog must offer Bob auto");
  assert.match(dialogs, /model-option-bob-auto/, "Bob auto carries a stable test id");
  assert.match(dialogs, /routing-classifier-dialog-select/, "the model dialog exposes the classifier choice");
  assert.match(dialogs, /saveRoutingClassifier/, "changing the classifier saves the policy");
  assert.match(controls, /updateRoutingMode/, "mode changes must refresh the pickers");
  assert.match(controls, /elements\.reasoningLevelSelect\.disabled = !allowed \|\| auto/, "Bob auto locks the reasoning picker");
  assert.match(settings, /dataset\.routingHarness = descriptor\.id/, "each harness tab owns a routing grid");
  for (const testid of ["routing-enabled", "routing-cadence", "routing-confidence", "routing-classifier", "routing-save-button", "routing-clear-button", "model-auto-label"]) {
    assert.ok(index.includes(`data-testid="${testid}"`), `index.html must carry ${testid}`);
  }
  assert.ok(index.includes('data-settings-tab="classifiers"'), "the Classifiers tab must exist outside the Cluster tab");
  assert.ok(!index.includes('id="routingClassifier" data-testid="routing-classifier"></select></label>\n            <label>Evaluate difficulty'), "the classifier select must not live under Clusters");
  assert.match(worker, /const CACHE_NAME = "joint-bob-v\d+";/);
});
