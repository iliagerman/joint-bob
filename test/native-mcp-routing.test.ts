import assert from "node:assert/strict";
import test from "node:test";
import { runAsAccount } from "../src/account-context.js";
import * as agent from "../src/mcp/agent.js";
import { ManagedMcpClient } from "../src/mcp/client.js";
import { parseMcpServers } from "../src/mcp/store.js";

test("native definitions never enter the shared broker and remain account-local", async () => {
  const servers = parseMcpServers({ mcpServers: { native: { url: "https://example.invalid/mcp", authMode: "native" }, shared: { command: "node" } } });
  await runAsAccount({ accountId: "native-routing", username: "fixture", role: "admin", isRemoteLogin: false, homeNodeId: null }, async () => {
    agent.managedMcpStore("native-routing").install(servers);
    assert.equal(agent.managedMcpBridgeConfigs().native, undefined);
    assert.ok(agent.managedMcpBridgeConfigs().shared);
    const broker = new ManagedMcpClient(agent.managedMcpStore("native-routing"));
    await assert.rejects(broker.tools("native"), /Use the native Pi/);
    await assert.rejects(broker.start("native"), /Use the native Pi/);
    await broker.close();
    const native = agent.nativeMcpServerConfigs();
    assert.deepEqual(native, { native: { url: "https://example.invalid/mcp" } });
    await runAsAccount({ accountId: "other", username: "other", role: "admin", isRemoteLogin: false, homeNodeId: null }, async () => assert.deepEqual(agent.nativeMcpServerConfigs(), {}));
    assert.throws(() => parseMcpServers({ mcpServers: { invalid: { url: "https://example.invalid/mcp", authMode: "unknown" } } }));
  });
});
