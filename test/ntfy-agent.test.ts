import assert from "node:assert/strict";
import test from "node:test";

test("ntfy capability mints bound identities and safe instructions", async () => {
  const { agentCapabilityEnvironment, agentCapabilityInstructionFiles } = await import("../src/agent-capabilities.js");
  const { ntfyAgentIdentity } = await import("../src/ntfy-agent.js");
  for (const engine of ["pi", "claude"] as const) {
    const environment = agentCapabilityEnvironment("project", engine, "conversation");
    assert.ok(environment.JOINT_BOB_NTFY_CLI);
    assert.deepEqual(ntfyAgentIdentity(environment.JOINT_BOB_NTFY_TOKEN!), { projectId: "project", engine, conversationId: "conversation" });
  }
  const instructions = agentCapabilityInstructionFiles().find(({ path }) => path === "/virtual/JOINT_BOB_NTFY.md")!.content;
  assert.match(instructions, /Do not read or print.*token/i);
  assert.doesNotMatch(instructions, /JOINT_BOB_NTFY_TOKEN/);
});

test("ntfy request selects a sole fresh service and does not expose credentials", async () => {
  const { addNtfyService, deleteNtfyService } = await import("../src/ntfy.js");
  const received: Array<{ body: unknown; authorization?: string }> = [];
  const server = await new Promise<import("node:http").Server>(async (resolve) => {
    const { createServer } = await import("node:http");
    const instance = createServer((request, response) => {
      let body = ""; request.setEncoding("utf8"); request.on("data", (chunk) => body += chunk);
      request.on("end", () => { received.push({ body: JSON.parse(body), authorization: request.headers.authorization }); response.end("secret upstream body"); });
    });
    instance.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture address missing");
  const service = addNtfyService("Local", `http://127.0.0.1:${address.port}`, "secret-token");
  try {
    const { ntfyAgentRequest } = await import("../src/ntfy-publish.js");
    const identity = { projectId: "project", engine: "pi", conversationId: "conversation" };
    assert.deepEqual(await ntfyAgentRequest(identity, { operation: "status" }), { services: [{ id: service.id, name: "Local" }], defaultTopic: null, hasConversationTarget: false });
    assert.deepEqual(await ntfyAgentRequest(identity, { operation: "send", topic: "alerts", message: "héllo", title: "Done" }), { ok: true, topic: "alerts" });
    assert.deepEqual(received, [{ body: { topic: "alerts", message: "héllo", title: "Done" }, authorization: "Bearer secret-token" }]);
  } finally { deleteNtfyService(service.id); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("ntfy request rejects configuration ambiguity and unsafe payload fields", async () => {
  const { ntfyAgentRequest, ntfyAgentRequestSchema, NtfyRequestError } = await import("../src/ntfy-publish.js");
  const identity = { projectId: "none", engine: "pi", conversationId: "none" };
  await assert.rejects(ntfyAgentRequest(identity, { operation: "send", topic: "x", message: "done" }), (error: unknown) => error instanceof NtfyRequestError && error.status === 409);
  assert.throws(() => ntfyAgentRequestSchema.parse({ operation: "send", topic: "bad/topic", message: "", url: "https://example.com", token: "secret", projectId: "other" }));
});
