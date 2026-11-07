import assert from "node:assert/strict";
import test from "node:test";
import { KiroV3Protocol, kiroV3Configuration, kiroV3ToolAllowed } from "../src/harnesses/kiro/v3.js";

const settings = { provider: "kiro", modelId: "chosen", reasoning: "medium" };
function configuration(model = "chosen") {
  return [
    { id: "model", type: "select", currentValue: model, options: [{ value: "chosen", name: "Chosen" }, { value: "other", name: "Other" }] },
    { id: "effortLevel", type: "select", currentValue: "medium", options: [{ value: "medium", name: "Medium" }] },
    { id: "autopilot", type: "select", currentValue: "off", options: [{ value: "off", name: "Off" }] },
  ];
}

test("V3 chooses advertised model configuration and rejects missing or unapplied choices", async () => {
  const calls: { method: string; params: unknown }[] = [];
  const protocol = new KiroV3Protocol({ async request(method, params) {
    calls.push({ method, params });
    return method === "session/new" ? { sessionId: "native", modes: { currentModeId: "joint-bob" }, configOptions: configuration("other") } : { configOptions: configuration() };
  } }, { _meta: { kiro: { extensionMethods: [] } } });
  await protocol.open("/fixture", "joint-bob", settings, null);
  assert.deepEqual(calls[1], { method: "session/set_config_option", params: { sessionId: "native", configId: "model", value: "chosen" } });
  for (const options of [[], configuration("other")]) {
    const broken = new KiroV3Protocol({ async request() { return { sessionId: "native", modes: { currentModeId: "joint-bob" }, configOptions: options }; } }, {});
    await assert.rejects(broken.open("/fixture", "joint-bob", settings, null), /does not advertise|did not apply/);
  }
});

test("V3 never falls back from the isolated custom mode or calls an unadvertised extension", async () => {
  const calls: string[] = [];
  const protocol = new KiroV3Protocol({ async request(method) { calls.push(method); return { sessionId: "native", modes: { currentModeId: "vibe" }, configOptions: configuration() }; } }, {});
  await assert.rejects(protocol.open("/fixture", "joint-bob", settings, null), /did not load the Joint Bob agent profile/);
  await assert.rejects(protocol.compact("native"), /does not advertise compaction/);
  assert.deepEqual(calls, ["session/new"]);
  assert.deepEqual(kiroV3Configuration([{ id: "future", type: "select", currentValue: 1 }]), []);
});

test("V3 restriction approval uses consent, never displayed names or MCP hints", () => {
  const request = { toolCall: { title: "Read harmless data", kind: "read" }, _meta: { kiro: { consent: { capability: "shell", resource: "rm file" }, mcpTool: { version: 1, annotations: { readOnlyHint: true } } } } };
  const builtIn = { _meta: { kiro: { consent: { capability: "mcp", resource: "joint_bob/browser" } } } };
  assert.equal(kiroV3ToolAllowed(builtIn, ["@joint_bob/browser"]), true);
  assert.equal(kiroV3ToolAllowed(builtIn, ["@another/browser"]), false);
  assert.equal(kiroV3ToolAllowed(request, ["read"]), false);
  assert.equal(kiroV3ToolAllowed(request, ["shell"]), true);
  assert.equal(kiroV3ToolAllowed({ toolCall: { title: "Read", kind: "read" } }, ["read"]), false);
  assert.equal(kiroV3ToolAllowed({ _meta: { kiro: { consent: { capability: "fs_read", resource: "/fixture" } } } }, ["read"]), true);
});
