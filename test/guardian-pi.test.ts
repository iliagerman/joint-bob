import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { GuardianVerdict } from "../src/guardian/check.js";
import type { GuardianRequest } from "../src/guardian/rules.js";
import { createCoreSession, type PiCoreHooks } from "../src/pi-session-core.js";

/** An OpenAI-compatible model that asks for each tool call in turn, then answers. */
function scriptedModel(steps: Array<{ command: string } | { text: string }>): Promise<{ server: Server; url: string; bodies: string[] }> {
  const bodies: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      bodies.push(body);
      const step = steps[bodies.length - 1] ?? { text: "done" };
      const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      if ("command" in step) {
        response.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call-${bodies.length}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: step.command }) } }] }, null));
        response.write(chunk({}, "tool_calls"));
      } else {
        response.write(chunk({ role: "assistant", content: step.text }, null));
        response.write(chunk({}, "stop"));
      }
      response.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, bodies })));
}

test("Guardian in a Pi session blocks a tool call, removes a secret from its output and rewrites a message", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-guardian-pi-"));
  const agentDir = path.join(root, ".pi", "agent");
  const cwd = path.join(root, "project");
  const packageDir = path.join(root, "provider");
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(cwd, { recursive: true }), mkdir(path.join(packageDir, "extensions"), { recursive: true })]);
  await writeFile(path.join(cwd, "keep.txt"), "important");
  const model = await scriptedModel([{ command: "rm -f keep.txt" }, { command: "echo key=AKIAABCDEFGHIJKLMNOP" }, { text: "done" }]);
  try {
    await writeFile(path.join(packageDir, "extensions", "provider.ts"), `export default pi => pi.registerProvider("fixture-provider", {
      api: "openai-completions", baseUrl: ${JSON.stringify(model.url)}, apiKey: "fixture-key",
      models: [{ id: "fixture-model", name: "Fixture Model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }]
    });`);
    await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [packageDir] }));
    const asked: GuardianRequest[] = [];
    const hooks: PiCoreHooks = {
      conversationId: async (sessionId) => sessionId,
      persistAccounts: async () => {},
      credentials: async () => ({ environment: {}, capabilityEnvironment: {}, credentialContext: "" }),
      resources: async () => ({ strictResourceIsolation: true, packagesFile: "", extensions: [], prompts: [], themes: [], agentsFiles: [], skillRoots: [], managedSkillRoot: path.join(root, "skills"), blockedSkillNames: [] }),
      guardian: async (_conversationId, request): Promise<GuardianVerdict> => {
        asked.push(request);
        if (request.kind === "tool" && String(request.input.command).startsWith("rm")) return { action: "block", reason: "GUARDIAN-BLOCKED-RM" };
        if (request.kind === "outgoing" && request.text.includes("AKIA")) return { action: "replace", text: request.text.replace(/AKIA\w+/, "[removed]") };
        if (request.kind === "outgoing" && request.text.includes("PROMPT-SECRET")) return { action: "replace", text: "please continue" };
        return { action: "continue" };
      },
    };
    const handle = await createCoreSession(await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false }), {
      cwd, agentDir, sessionRoot: path.join(root, "sessions"), sessionId: "guardian-session",
      defaults: { provider: "fixture-provider", modelId: "fixture-model", thinkingLevel: "off" },
    }, hooks);
    try { await handle.session.prompt("PROMPT-SECRET please clean up"); }
    finally { handle.dispose(); }

    assert.ok(existsSync(path.join(cwd, "keep.txt")), "the blocked command never ran");
    assert.ok(!model.bodies[0].includes("PROMPT-SECRET") && model.bodies[0].includes("please continue"), "the rewritten message is what the model got");
    assert.ok(model.bodies[1].includes("GUARDIAN-BLOCKED-RM"), "the model is told why the call was blocked");
    // The model wrote the command itself, so only the tool's output is new to it.
    const toolOutputs = (JSON.parse(model.bodies[2]) as { messages: Array<{ role: string; content: unknown }> }).messages.filter((message) => message.role === "tool").map((message) => JSON.stringify(message.content));
    assert.ok(toolOutputs.at(-1)!.includes("key=[removed]") && !toolOutputs.at(-1)!.includes("AKIA"), "the secret in the output never reached the model");
    assert.deepEqual(asked.map((request) => request.kind === "tool" ? `tool:${request.tool}:${request.category}` : `outgoing:${request.source}`).slice(0, 4),
      ["outgoing:the user's message", "tool:bash:commands", "tool:bash:commands", "outgoing:the output of bash"], "a blocked call has no output to check");
  } finally {
    await new Promise<void>((resolve) => model.server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
