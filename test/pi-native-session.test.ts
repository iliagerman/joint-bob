import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAsAccount } from "../src/account-context.js";
import { getAgentDir, piSdkEntry } from "../src/pi-sdk.js";
import { createPiNativeMcp, piMcpCredentialDirectory } from "../src/mcp/pi-native.js";
import { nativeCallback, nativeMcpFixture } from "./native-mcp-fixture.js";
import { managedMcpStore } from "../src/mcp/agent.js";
const sdk = await import(piSdkEntry ?? import.meta.resolve("@earendil-works/pi-coding-agent"));
test("native OAuth grant is consumed by a real Pi session, survives reopen, and sign-out revokes access", { skip: typeof sdk.createMcpExtension !== "function" ? "Requires selected modern Pi SDK" : false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-native-session-")), fixture = await nativeMcpFixture();
  const account = { accountId: "native-session", username: "fixture", role: "admin" as const, isRemoteLogin: false, homeNodeId: null };
  const { createPiSession, piSessionHooks } = await import("../src/pi-service.js");
  const config = { fixture: { url: `${fixture.origin}/mcp` } };
  const auth = await createPiNativeMcp(config, piMcpCredentialDirectory(getAgentDir(), account.accountId), root);
  const handles: Array<{ dispose(): void }> = [];
  try {
    // Ambient native configuration must never enter this session.
    await writeFile(path.join(getAgentDir(), "mcp.json"), JSON.stringify({ mcpServers: { ambient: { command: "never-run" } } }));
    const start = await auth.start("fixture");
    assert.equal((await auth.finish(nativeCallback(start.authUrl!).href)).status, "connected");
    await runAsAccount(account, async () => {
      managedMcpStore(account.accountId).install({ fixture: { ...config.fixture, authMode: "native" } });
      const { addProject } = await import("../src/store.js");
      const project = await addProject("Native fixture", root, { writeInstructions: false });
      const resources = await piSessionHooks({ cwd: root, projectId: project.id }).resources("native-session-0");
      assert.deepEqual(resources.nativeMcp?.servers, config);
      for (let index = 0; index < 2; index++) {
        const handle = await createPiSession({ cwd: root, projectId: project.id, sessionId: `native-session-${index}` }); handles.push(handle);
        let tool;
        for (let attempt = 0; attempt < 100; attempt++) {
          tool = handle.session.agent.state.tools.find(tool => tool.name === "mcp__fixture__inspect");
          if (tool) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.ok(tool, "native MCP tool must be registered in the real Pi session");
        assert.equal(handle.session.getAllTools().some(tool => tool.name.startsWith("mcp__ambient")), false);
        const result = await tool.execute("fixture", {});
        assert.equal(result.content[0].type === "text" && result.content[0].text, "Native authenticated call");
        if (index === 1) {
          await auth.signOut("fixture");
          await assert.rejects(tool.execute("after-sign-out", {}));
        }
        handle.dispose();
      }
      assert.equal(fixture.calls(), 2);
      await auth.signOut("fixture");
      assert.equal((await auth.status())[0].status, "needs-auth");
      await assert.rejects(auth.call("fixture", "inspect", {}));
      const { savePersonalAssistant } = await import("../src/personal-assistants.js");
      await savePersonalAssistant(account.accountId, { projectId: project.id, engine: "pi", sessionId: "restricted", name: "Restricted", instructions: "Fixture", mcpServerNames: [] });
      assert.deepEqual((await piSessionHooks({ cwd: root, projectId: project.id }).resources("restricted")).nativeMcp?.servers, {});
      const { setActivationPreference } = await import("../src/resource-activation.js");
      setActivationPreference("mcp", "fixture", "pi", false);
      assert.deepEqual((await piSessionHooks({ cwd: root, projectId: project.id }).resources("ordinary")).nativeMcp?.servers, {});
    });
  } finally { handles.forEach(handle => handle.dispose()); await auth.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); }
});
