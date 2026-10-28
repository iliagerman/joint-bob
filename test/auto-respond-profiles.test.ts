import assert from "node:assert/strict";
import test from "node:test";
import { autoRespondConfigSchema, enableAutoRespond, getAutoRespond, stopAutoRespond, validateAutoRespondProfile } from "../src/conversation-auto-respond.js";
import { runAutoResponder } from "../src/server/auto-respond-run.js";
import { createProviderProfile, deleteProviderProfile, setProviderProfileShared } from "../src/provider-profiles/store.js";

const config = { harnessId: "claude", provider: "claude", modelId: "test", thinkingLevel: "default" as const, instructions: "Review", stopInstructions: "", maxResponses: 2, useTools: false };

test("auto replies persist server supplied creator and nullable profile through state changes", async () => {
  assert.equal(autoRespondConfigSchema.parse(config).providerProfileId, null);
  assert.throws(() => autoRespondConfigSchema.parse({ ...config, creatorAccountId: "forged" }));
  await enableAutoRespond("profile-test", "default", config, null, "creator");
  await stopAutoRespond("profile-test", "default", "user-stopped", "Stopped");
  const saved = await getAutoRespond("profile-test", "default");
  assert.equal(saved?.creatorAccountId, "creator");
  assert.equal(saved?.providerProfileId, null);
});

test("auto reply execution carries the persisted creator and pinned or current assignment", async () => {
  const previous = process.env.JOINT_BOB_AUTO_RESPONDER;
  process.env.JOINT_BOB_AUTO_RESPONDER = new URL("./fixtures/auto-respond-profile-context.ts", import.meta.url).href;
  const profile = createProviderProfile("execution-creator", { label: "Execution", provider: "claude" });
  try {
    for (const profileId of [null, profile.id]) {
      const output = await runAutoResponder({ creatorAccountId: "execution-creator", accountIds: ["viewer"], projectId: "profile-test", conversationId: "execution", cwd: process.cwd(), config: { ...config, providerProfileId: profileId }, prompt: "test", signal: new AbortController().signal, onStep() {} });
      assert.deepEqual(JSON.parse(output), { accountId: "execution-creator", profileId });
    }
  } finally {
    if (previous === undefined) delete process.env.JOINT_BOB_AUTO_RESPONDER;
    else process.env.JOINT_BOB_AUTO_RESPONDER = previous;
    deleteProviderProfile("execution-creator", profile.id);
  }
});

test("explicit auto reply profiles persist and reject inaccessible, mismatched or deleted assignments", async () => {
  const profile = createProviderProfile("creator", { label: "Responder", provider: "claude" });
  const pinned = { ...config, providerProfileId: profile.id };
  await enableAutoRespond("profile-test", "pinned", pinned, null, "creator");
  assert.equal((await getAutoRespond("profile-test", "pinned"))?.providerProfileId, profile.id);
  await assert.rejects(enableAutoRespond("profile-test", "other", pinned, null, "other"));
  assert.throws(() => validateAutoRespondProfile("creator", { ...pinned, provider: "openai-codex" }), /provider/i);
  assert.throws(() => validateAutoRespondProfile(null, pinned), /creator/i);
  setProviderProfileShared("creator", profile.id, true);
  await enableAutoRespond("profile-test", "shared", pinned, null, "other");
  setProviderProfileShared("creator", profile.id, false);
  await assert.rejects(runAutoResponder({ creatorAccountId: "other", projectId: "profile-test", conversationId: "shared", cwd: process.cwd(), config: pinned, prompt: "test", signal: new AbortController().signal, onStep() {} }), /profile/i);
  deleteProviderProfile("creator", profile.id);
  assert.throws(() => validateAutoRespondProfile("creator", pinned), /profile/i);
  await assert.rejects(runAutoResponder({ creatorAccountId: "creator", projectId: "profile-test", conversationId: "pinned", cwd: process.cwd(), config: pinned, prompt: "test", signal: new AbortController().signal, onStep() {} }), /profile/i);
});
