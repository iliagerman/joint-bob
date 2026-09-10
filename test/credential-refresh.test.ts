import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

process.env.ANTHROPIC_API_KEY = "test-model-key";
for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "PI_GITHUB_TOKEN", "JOINT_BOB_BROWSER_CLI", "JOINT_BOB_BROWSER_URL"]) delete process.env[name];
const { addProject } = await import("../src/store.js");
const { createPiSession, reloadPiSkills } = await import("../src/pi-service.js");
const secrets = await import("../src/secrets.js");

type Model = Parameters<ModelRuntime["streamSimple"]>[0];
type Context = Parameters<ModelRuntime["streamSimple"]>[1];

function response(model: Model) {
  const message = { role: "assistant" as const, content: [{ type: "text" as const, text: "done" }],
    api: model.api, provider: model.provider, model: model.id, stopReason: "stop" as const, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message }; }, result: async () => message };
}

async function fixture(t: test.TestContext, accountIds: string[] = []) {
  const cwd = path.join(os.homedir(), `credentials-${Date.now()}`);
  await mkdir(cwd, { recursive: true });
  const project = await addProject("Credential refresh", cwd, { writeInstructions: false });
  const handle = await createPiSession({ cwd, projectId: project.id, conversation: { engine: "pi", accountIds } });
  t.after(() => handle.dispose());
  let inspect = async (_context: Context) => {};
  let inspected = 0;
  t.mock.method(ModelRuntime.prototype, "streamSimple", async (model: Model, context: Context) => {
    inspected += 1;
    await inspect(context);
    return response(model);
  });
  const prompt = async (text: string) => {
    const previous = inspected;
    await handle.session.prompt(text);
    assert.ok(inspected > previous, "each prompt must reach the model inspection");
    const errors = handle.session.messages.filter((message) => message.role === "assistant" && message.stopReason === "error");
    assert.deepEqual(errors, [], "model inspection and shell assertions must succeed");
  };
  return { project, handle, prompt, inspect: (callback: typeof inspect) => { inspect = callback; } };
}

async function account(label: string, value: string, id?: string) {
  return secrets.saveSecretAccount({ id, label, provider: "github", variables: [{ name: "GH_TOKEN", kind: "value", value }] });
}

async function checkShell(handle: Awaited<ReturnType<typeof createPiSession>>, expected: string) {
  const bash = handle.session.agent.state.tools.find((tool) => tool.name === "bash")!;
  const command = `if [ "$GH_TOKEN" = '${expected}' ] && [ "$GITHUB_TOKEN" = '${expected}' ] && [ "$PI_GITHUB_TOKEN" = '${expected}' ] && [ -n "$JOINT_BOB_BROWSER_CLI" ] && [ -n "$JOINT_BOB_BROWSER_URL" ]; then printf matched; else printf mismatch; fi`;
  const result = await bash.execute("credential-check", { command });
  assert.deepEqual(result.content, [{ type: "text", text: "matched" }]);
}

test("existing Pi session refreshes workspace attachment, rotation and removal before messages", async (t) => {
  const f = await fixture(t);
  let expected = "";
  let label = "";
  f.inspect(async (context) => {
    await checkShell(f.handle, expected);
    if (label) assert.match(context.systemPrompt!, new RegExp(label));
    else assert.doesNotMatch(context.systemPrompt!, /Workspace GitHub/);
    assert.doesNotMatch(context.systemPrompt!, /fixture-token-/);
  });
  await f.prompt("first");
  const saved = await account("Workspace GitHub", "fixture-token-first");
  await secrets.setScopeSecretAccounts("workspace", "personal", [saved.id]);
  expected = "fixture-token-first"; label = "Workspace GitHub";
  await f.prompt("attached");
  await reloadPiSkills(f.handle);
  await account("Workspace GitHub rotated", "fixture-token-second", saved.id);
  expected = "fixture-token-second"; label = "Workspace GitHub rotated";
  await f.prompt("rotated");
  const projectAccount = await account("Project GitHub", "fixture-token-project");
  await secrets.setScopeSecretAccounts("project", f.project.id, [projectAccount.id]);
  expected = "fixture-token-project"; label = "Project GitHub";
  await f.prompt("project override");
  await secrets.deleteSecretAccount(projectAccount.id);
  expected = "fixture-token-second"; label = "Workspace GitHub rotated";
  await f.prompt("fallback to workspace");
  await secrets.setScopeSecretAccounts("workspace", "personal", []);
  expected = ""; label = "";
  await f.prompt("removed");
});

test("conversation selections use the persisted session id, not stale startup accountIds", async (t) => {
  const saved = await account("Conversation GitHub", "fixture-token-conversation");
  const f = await fixture(t, [saved.id]);
  let expected = "fixture-token-conversation";
  f.inspect(async (context) => {
    await checkShell(f.handle, expected);
    assert.equal(context.systemPrompt!.includes("Conversation GitHub"), Boolean(expected));
  });
  await f.prompt("selected");
  await secrets.setScopeSecretAccounts("conversation", `pi:${f.handle.session.sessionId}`, []);
  expected = "";
  await f.prompt("detached");
});

for (const method of ["followUp", "steer"] as const) test(`Pi ${method} messages refresh when consumed without changing a running message`, async (t) => {
  const saved = await account("Queued GitHub", "fixture-token-before");
  const f = await fixture(t);
  await secrets.setScopeSecretAccounts("project", f.project.id, [saved.id]);
  let calls = 0;
  f.inspect(async (context) => {
    if (++calls === 1) {
      await account("Queued GitHub updated", "fixture-token-after", saved.id);
      await f.handle.session[method]("queued");
      await checkShell(f.handle, "fixture-token-before");
      assert.doesNotMatch(context.systemPrompt!, /Queued GitHub updated/);
    } else {
      await checkShell(f.handle, "fixture-token-after");
      assert.match(context.systemPrompt!, /Queued GitHub updated/);
    }
  });
  await f.prompt("running");
  assert.equal(calls, 2);
});
