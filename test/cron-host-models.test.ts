import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../public/app/cron.js", import.meta.url), "utf8");
const refresh = source.slice(source.indexOf("async function refreshHostModels("), source.indexOf("function modelsForHarness("));

function fixture() {
  const fields = Object.fromEntries(["model", "reasoning", "autoReplyModel", "autoReplyThinking", "ownerNodeId"].map(name => [name, {
    value: name === "ownerNodeId" ? "remote-host" : name === "model" ? "anthropic|claude" : "",
    disabled: false,
    replaceChildren() { this.value = ""; },
  }]));
  const requests: Array<{ nodeId: string; input: unknown; resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  const rendered: unknown[] = [];
  const submit = { disabled: false };
  const errorText = { textContent: "" };
  const sandbox = vm.createContext({
    modelRequest: 0, availableModels: [], context: { projectId: "project" }, errorText,
    field: (name: string) => fields[name], formActions: { querySelector: () => submit },
    Option: class {}, selectedModel: () => ({ provider: "anthropic", modelId: "claude" }),
    renderExecutionFields: (...args: unknown[]) => rendered.push(args), fillAutoReplyModels: () => {},
    command: (nodeId: string, input: unknown) => new Promise((resolve, reject) => requests.push({ nodeId, input, resolve, reject })),
  });
  vm.runInContext(refresh, sandbox);
  return { fields, requests, rendered, submit, errorText, sandbox, load: () => vm.runInContext("refreshHostModels()", sandbox) as Promise<void> };
}

test("scheduled models come from the selected host and retain the saved model", async () => {
  const f = fixture();
  const pending = f.load();
  assert.equal(f.requests[0].nodeId, "remote-host");
  assert.equal(JSON.stringify(f.requests[0].input), JSON.stringify({ action: "models", projectId: "project" }));
  assert.equal(f.submit.disabled, true);
  const models = [{ harnessId: "pi", provider: "anthropic", id: "claude" }];
  f.requests[0].resolve({ models });
  await pending;
  assert.equal(f.sandbox.availableModels, models);
  assert.equal((f.rendered[0] as string[])[0], "anthropic|claude");
  assert.equal(f.submit.disabled, false);
});

test("a late response from a previous host cannot replace the selected host models", async () => {
  const f = fixture();
  const first = f.load();
  f.fields.ownerNodeId.value = "other-host";
  const second = f.load();
  const models = [{ id: "other-model" }];
  f.requests[1].resolve({ models });
  await second;
  f.requests[0].resolve({ models: [{ id: "stale" }] });
  await first;
  assert.equal(f.sandbox.availableModels, models);
  assert.equal(f.rendered.length, 1);
});

test("an unavailable host reports the error and prevents saving with stale models", async () => {
  const f = fixture();
  const pending = f.load();
  f.requests[0].reject(new Error("Scheduled task owner is unavailable"));
  await pending;
  assert.equal(f.errorText.textContent, "Scheduled task owner is unavailable");
  assert.equal(f.submit.disabled, true);
  assert.equal(f.fields.model.disabled, true);
  assert.equal(f.sandbox.availableModels.length, 0);
});
