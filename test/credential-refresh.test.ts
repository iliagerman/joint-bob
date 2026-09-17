import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { startSupervisor } from "../scripts/joint-bob-supervisor.mjs";
import { resolveDataDirectory } from "../src/data-directory.js";

process.env.ANTHROPIC_API_KEY = "test-model-key";
for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "PI_GITHUB_TOKEN", "JOINT_BOB_BROWSER_CLI", "JOINT_BOB_BROWSER_URL"]) delete process.env[name];
const { addProject } = await import("../src/store.js");
const { getSettings, updateSettings } = await import("../src/settings.js");
const settings = getSettings();
updateSettings({ ...settings, conversationDefaults: { ...settings.conversationDefaults, pi: { provider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevel: "medium" } } });
const { createPiSession, reloadPiSkills } = await import("../src/pi-service.js");
const { browserAgentCredential, browserAgentIdentity } = await import("../src/browser-agent.js");
const secrets = await import("../src/secrets.js");

let supervisor: Awaited<ReturnType<typeof startSupervisor>> | undefined;
let previousWarning: string | undefined;

before(async () => {
  supervisor = await startSupervisor({
    dataDirectory: resolveDataDirectory(),
    app: {
      executable: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: os.homedir(),
      env: { PATH: process.env.PATH ?? "", HOME: os.homedir() },
    },
  });
  previousWarning = process.env.NODE_NO_WARNINGS;
  process.env.NODE_NO_WARNINGS = "1";
});

after(async () => {
  await supervisor?.close();
  if (previousWarning === undefined) delete process.env.NODE_NO_WARNINGS;
  else process.env.NODE_NO_WARNINGS = previousWarning;
});

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

async function websiteAccount(label: string, value: string, id?: string) {
  return secrets.saveSecretAccount({ id, label, provider: "custom", websiteOrigin: "https://login.fixture.test", variables: [{ name: "LOGIN_PASSWORD", kind: "value", value }] });
}

async function browserCapture(handle: Awaited<ReturnType<typeof createPiSession>>) {
  const bash = handle.session.agent.state.tools.find((tool) => tool.name === "bash")!;
  const result = await bash.execute("browser-credential-check", { command: `printf '%s\\n%s' "$JOINT_BOB_BROWSER_TOKEN" "\${LOGIN_PASSWORD+x}"` });
  const text = result.content.find((part) => part.type === "text")?.text ?? "";
  const [token, websiteEnvPresent] = text.split("\n");
  return { token, websiteEnvPresent: websiteEnvPresent === "x" };
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

test("Pi snapshots website credentials by origin without exporting plaintext", async (t) => {
  const f = await fixture(t);
  const saved = await websiteAccount("Fixture Login", "website-value-first");
  await secrets.setScopeSecretAccounts("project", f.project.id, [saved.id]);
  let previousToken = "";
  let expected = "website-value-first";
  f.inspect(async (context) => {
    const capture = await browserCapture(f.handle);
    assert.equal(capture.websiteEnvPresent, false);
    assert.deepEqual(browserAgentCredential(capture.token, saved.id, "LOGIN_PASSWORD"), { origin: "https://login.fixture.test", value: expected });
    assert.deepEqual(browserAgentIdentity(capture.token), { projectId: f.project.id, engine: "pi", conversationId: f.handle.session.sessionId });
    assert.match(context.systemPrompt!, /Fixture Login|login\.fixture\.test|LOGIN_PASSWORD/);
    assert.doesNotMatch(context.systemPrompt!, /website-value-(first|second)/);
    if (previousToken) assert.notEqual(capture.token, previousToken);
    previousToken = capture.token;
  });
  await f.prompt("attached");
  const firstToken = previousToken;
  await websiteAccount("Fixture Login", "website-value-second", saved.id);
  expected = "website-value-second";
  await f.prompt("rotated");
  assert.equal(browserAgentCredential(firstToken, saved.id, "LOGIN_PASSWORD").value, "website-value-first");
  await secrets.deleteSecretAccount(saved.id);
  f.inspect(async () => {
    const capture = await browserCapture(f.handle);
    assert.equal(capture.websiteEnvPresent, false);
    await assert.rejects(async () => browserAgentCredential(capture.token, saved.id, "LOGIN_PASSWORD"), /unavailable/);
  });
  await f.prompt("removed");
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

for (const method of ["followUp", "steer"] as const) test(`Pi ${method} keeps a running website snapshot stable`, async (t) => {
  const saved = await websiteAccount("Queued Login", "queued-website-before");
  const f = await fixture(t);
  await secrets.setScopeSecretAccounts("project", f.project.id, [saved.id]);
  let calls = 0;
  let firstToken = "";
  f.inspect(async (context) => {
    const capture = await browserCapture(f.handle);
    assert.equal(capture.websiteEnvPresent, false);
    if (++calls === 1) {
      firstToken = capture.token;
      await websiteAccount("Queued Login", "queued-website-after", saved.id);
      await f.handle.session[method]("queued website");
      assert.equal(browserAgentCredential(capture.token, saved.id, "LOGIN_PASSWORD").value, "queued-website-before");
      assert.doesNotMatch(context.systemPrompt!, /queued-website-(before|after)/);
    } else {
      assert.notEqual(capture.token, firstToken);
      assert.equal(browserAgentCredential(capture.token, saved.id, "LOGIN_PASSWORD").value, "queued-website-after");
      assert.equal(browserAgentCredential(firstToken, saved.id, "LOGIN_PASSWORD").value, "queued-website-before");
    }
  });
  await f.prompt("running website");
  assert.equal(calls, 2);
});
