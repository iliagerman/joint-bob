import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Joint Bob's own background work must not assume Pi: it runs on an agent that is signed in
// here, at that agent's default model and effort, unless Settings names one.
test("the background agent is the first signed-in agent, or the one chosen in Settings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-background-agent-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  try {
    const settings = await import("../src/settings.js");
    const readiness = await import("../src/harness-readiness.js");
    const { agentFor } = await import("../src/background-agent.js");
    const { iconHarnessId } = await import("../src/server/label-icon.js");
    const defaults = settings.getSettings().conversationDefaults;

    readiness.forgetReadyHarnesses();
    assert.equal(settings.backgroundAgentNow().harnessId, "pi", "before any sign-in check, the first agent that can run");

    readiness.rememberReadyHarnesses(["claude", "kiro"]);
    const automatic = settings.backgroundAgentNow();
    assert.deepEqual(automatic, { harnessId: "claude", source: "automatic", ...defaults.claude }, "Pi is not signed in, so Claude at its default model and effort");
    assert.equal(iconHarnessId(), "claude", "icons follow the background agent");
    assert.deepEqual(agentFor({ harnessId: "", provider: "", modelId: "", thinkingLevel: "" }), { harnessId: "claude", provider: defaults.claude.provider, modelId: defaults.claude.modelId, thinkingLevel: defaults.claude.thinkingLevel }, "work with no agent of its own takes the background agent's model too");
    assert.equal(agentFor({ harnessId: "kiro", provider: "", modelId: "", thinkingLevel: "" }).harnessId, "kiro", "work with its own agent keeps it");
    assert.equal(settings.getSettings().syncCheck.harnessId, "claude", "an unsaved sync check follows the background agent");

    readiness.rememberReadyHarnesses(["pi", "claude"]);
    assert.equal(settings.backgroundAgentNow().harnessId, "pi", "Pi first when it is signed in");

    const claudeModel = { harnessId: "claude", provider: defaults.claude.provider, modelId: `chosen-${randomUUID()}`, thinkingLevel: "low" };
    settings.updateSettings({ backgroundAgent: claudeModel });
    assert.deepEqual(settings.getSettings().backgroundAgent, claudeModel);
    assert.deepEqual(settings.backgroundAgentNow(), { ...claudeModel, source: "setting" }, "a chosen agent and model win over automatic");

    settings.updateSettings({ backgroundAgent: { harnessId: "kiro", provider: "", modelId: "", thinkingLevel: "" } });
    assert.deepEqual(settings.backgroundAgentNow(), { harnessId: "kiro", source: "setting", ...defaults.kiro }, "an agent chosen without a model runs at its own default");

    assert.throws(() => settings.updateSettings({ backgroundAgent: { harnessId: "nonexistent", provider: "", modelId: "", thinkingLevel: "" } }), /^Error: Background agent harness nonexistent cannot run agents on this node/);
    settings.updateSettings({ backgroundAgent: { harnessId: "", provider: "x", modelId: "y", thinkingLevel: "high" } });
    assert.deepEqual(settings.getSettings().backgroundAgent, { harnessId: "", provider: "", modelId: "", thinkingLevel: "" }, "automatic keeps no model");
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  }
});

// The node's credential sharing refused accounts of providers it did not list (typesafe), and
// that one account stopped every scoped delivery from the node.
test("scoped credential sharing accepts every secret provider", async () => {
  const { SECRET_PROVIDERS } = await import("../src/secrets.js");
  const { scopedCredentialSchema } = await import("../src/server/scoped-credentials.js");
  for (const provider of SECRET_PROVIDERS) {
    const account = {
      id: randomUUID(), label: `Synthetic ${provider}`, provider,
      ...(provider === "website" ? { websiteOrigin: "https://example.test" } : {}),
      variables: [{ name: "SYNTHETIC_VALUE", kind: "value", value: "synthetic" }],
      updatedAt: new Date().toISOString(), scopes: [], grants: [],
    };
    const parsed = scopedCredentialSchema.safeParse({ accounts: [account] });
    assert.ok(parsed.success, `${provider}: ${parsed.success ? "" : parsed.error.message}`);
  }
});
