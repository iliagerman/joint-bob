import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAsAccount, type ActingAccount } from "../src/account-context.js";
import { managedMcpStore, managedMcpBridgeConfigs, mcpAgentIdentity, mcpAgentEnvironment, revokeMcpAgentTokens } from "../src/mcp/agent.js";
import { claudeResourceIsolationArgs } from "../src/harnesses/claude/resources.js";
import { kiroAgentProfile } from "../src/harnesses/kiro/resources.js";
import { getSettings } from "../src/settings.js";

const account: ActingAccount = { accountId: "mcp-account-fixture", username: "fixture", role: "admin", isRemoteLogin: false, homeNodeId: null };
test("all harnesses receive the same bundled bridge, while capabilities stay bound to their account and conversation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-harnesses-"));
  await runAsAccount(account, async () => {
    try {
      const store = managedMcpStore(account.accountId); store.install({ fixture: { url: "https://fixture.invalid/mcp" } });
      const config = managedMcpBridgeConfigs();
      assert.equal(config.fixture.command, process.execPath); assert.match(config.fixture.args[0], /joint-bob-mcp\.mjs$/);
      const environment = mcpAgentEnvironment("fixture-project", "pi", "fixture-conversation");
      const identity = mcpAgentIdentity(environment.JOINT_BOB_MCP_TOKEN!);
      assert.equal(identity?.account.accountId, account.accountId); assert.equal(identity?.engine, "pi");
      assert.equal(identity?.conversationId, "fixture-conversation");
      const args = claudeResourceIsolationArgs(root, []), index = args.indexOf("--mcp-config");
      assert.ok(index >= 0);
      const native = JSON.parse(await readFile(args[index + 1], "utf8")); assert.deepEqual(native.mcpServers.fixture, config.fixture);
      const profile = await kiroAgentProfile({ cwd: root, projectId: "fixture-project", sessionId: "mcpfixture" }, "Synthetic credential context");
      const kiro = JSON.parse(await readFile(path.join(getSettings().runtimes.kiro.configPath, "agents", `${profile}.json`), "utf8"));
      assert.deepEqual(kiro.mcpServers.fixture, config.fixture);
      assert.doesNotMatch(JSON.stringify(native), /JOINT_BOB_MCP_TOKEN|access_token/);
      revokeMcpAgentTokens("fixture-project", "fixture-conversation");
      assert.equal(mcpAgentIdentity(environment.JOINT_BOB_MCP_TOKEN!), undefined);
      runAsAccount({ ...account, accountId: "other-account" }, () => assert.deepEqual(Object.keys(managedMcpBridgeConfigs()), ["joint_bob"], "only Joint Bob's own tools"));
      store.remove("fixture");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

test("the bundled Pi SDK registers and executes configured MCP tools without a user-installed extension", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-pi-core-"));
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const token = request.headers.authorization!.slice("Bearer ".length);
    assert.equal(mcpAgentIdentity(token)?.account.accountId, account.accountId);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(body.action === "tools" ? { tools: [{ name: "inspect", description: "Inspect fixture", inputSchema: { type: "object", properties: {} } }] } : { content: [{ type: "text", text: "Executed through bundled Pi" }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const previousPort = process.env.PORT; process.env.PORT = String((server.address() as { port: number }).port);
  let handle: { dispose(): void } | undefined;
  try {
    await runAsAccount(account, async () => {
      const store = managedMcpStore(account.accountId); store.install({ fixture: { url: "https://fixture.invalid/mcp" } });
      const { addProject } = await import("../src/store.js"), { createPiSession } = await import("../src/pi-service.js");
      const project = await addProject("MCP fixture", root, { writeInstructions: false });
      const session = await createPiSession({ cwd: root, projectId: project.id, sessionId: "bundled-mcp-fixture" }); handle = session;
      const tool = session.session.agent.state.tools.find(tool => tool.name === "mcp__fixture__inspect");
      assert.ok(tool, "Joint Bob must load the bundled MCP integration into the real Pi session");
      const result = await tool.execute("fixture", {});
      assert.deepEqual(result.content, [{ type: "text", text: "Executed through bundled Pi" }]);
      store.remove("fixture");
    });
  } finally { handle?.dispose(); if (previousPort === undefined) delete process.env.PORT; else process.env.PORT = previousPort; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
