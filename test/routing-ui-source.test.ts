import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Source assertions keep the routing configuration UI wiring from silently
// disappearing; the behaviour itself is covered by test/routing-configs.test.ts,
// test/routing-dispatch.test.ts, test/cluster-sanity.test.ts, and the browser suite.
test("routing configuration UI wiring stays connected and lives only under Classifiers", async () => {
  const [socket, transcript, configs, index, worker, controls, dialogs, settings, clusterPanel] = await Promise.all([
    readFile("public/app/socket.js", "utf8"),
    readFile("public/app/chat-transcript.js", "utf8"),
    readFile("public/app/routing-configs.js", "utf8"),
    readFile("public/index.html", "utf8"),
    readFile("public/sw.js", "utf8"),
    readFile("public/app/chat-controls.js", "utf8"),
    readFile("public/app/composer-dialogs.js", "utf8"),
    readFile("public/app/settings.js", "utf8"),
    readFile("public/app/cluster-panel.js", "utf8"),
  ]);
  assert.match(socket, /payload\.type === "promptRouted"/, "the socket must forward promptRouted to the transcript");
  assert.match(socket, /markPromptRouted/);
  assert.match(socket, /payload\.type === "routingMode"/, "the socket must forward routingMode");
  assert.match(transcript, /export function markPromptRouted/, "the transcript must render the routing note");
  assert.match(configs, /\/api\/routing-configs/, "the Classifiers panel must load the named configurations");
  assert.match(configs, /routing-configs\/selection/, "the panel must set this node's own active configuration");
  assert.match(configs, /routing-configs\/.*\/share/, "the panel must share a configuration explicitly");
  assert.match(configs, /routing-description/, "each configured option carries a classifier description");
  assert.match(configs, /saved, unavailable here/, "a saved mapping whose model is missing keeps its option instead of silently clearing");
  assert.match(configs, /notDetected/, "a harness present only in the saved policy keeps its grid");
  assert.match(configs, /Save and share/, "sharing an edited configuration saves it first");
  assert.match(dialogs, /\/api\/routing-configs/, "the model dialog reads classifiers from the configuration API");
  assert.match(dialogs, /saveRoutingClassifier/, "changing the classifier saves the active configuration");
  assert.match(dialogs, /bob-auto/, "the model dialog must offer Bob auto");
  assert.match(dialogs, /model-option-bob-auto/, "Bob auto carries a stable test id");
  assert.match(dialogs, /routing-classifier-dialog-select/, "the model dialog exposes the classifier choice");
  assert.match(controls, /updateRoutingMode/, "mode changes must refresh the pickers");
  assert.match(controls, /elements\.reasoningLevelSelect\.disabled = !allowed \|\| auto/, "Bob auto locks the reasoning picker");
  assert.doesNotMatch(clusterPanel, /routing/, "the Cluster panel no longer contains any routing control");
  assert.doesNotMatch(settings, /routingHarness = descriptor\.id/, "harness tabs no longer own a routing grid");

  const classifierPanel = index.slice(index.indexOf('id="settingsPanel-classifiers"'), index.indexOf('id="settingsPanel-resources"'));
  const clusterPanelHtml = index.slice(index.indexOf('id="settingsPanel-cluster"'), index.indexOf('id="settingsPanel-workspaces"'));
  const enginesPanel = index.slice(index.indexOf('id="settingsPanel-engines"'), index.indexOf('id="settingsPanel-classifiers"'));
  for (const testid of ["routing-active-config-select", "routing-config-list", "routing-config-create-button", "routing-config-editor", "routing-config-save-button", "routing-config-share-button", "routing-config-delete-button", "routing-enabled", "routing-cadence", "routing-cadence-n", "routing-context-messages", "routing-confidence", "routing-classifier"]) {
    assert.ok(classifierPanel.includes(`data-testid="${testid}"`), `the Classifiers panel must carry ${testid}`);
  }
  assert.ok(index.includes('data-testid="model-auto-label"'), "the chat toolbar still marks Bob auto");
  for (const forbidden of ["routing-active-config-select", "routing-config-editor", "data-testid=\"routing-classifier\"", "data-testid=\"routing-enabled\"", "data-testid=\"routing-confidence\"", "data-testid=\"routing-cadence\""]) {
    assert.ok(!clusterPanelHtml.includes(forbidden), `the Cluster panel must not contain ${forbidden}`);
    assert.ok(!enginesPanel.includes(forbidden), `the Harnesses panel must not contain ${forbidden}`);
  }
  assert.ok(index.includes('data-settings-tab="classifiers"'), "the Classifiers tab must exist");
  assert.match(worker, /const CACHE_NAME = "joint-bob-v\d+";/);
  assert.ok(worker.includes('"/app/routing-configs.js"'), "the service worker shell includes the new module");
});
