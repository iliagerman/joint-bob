import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

async function fixture(tag: string) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `joint-bob-website-${tag}-`));
  process.env.PI_WEB_DATA_DIR = dataDir;
  const database = new DatabaseSync(path.join(dataDir, "node.db"));
  database.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY); CREATE TABLE projects (id TEXT PRIMARY KEY, workspace_id TEXT); CREATE TABLE project_aliases (alias_id TEXT PRIMARY KEY, project_id TEXT); INSERT INTO workspaces VALUES ('work'); INSERT INTO projects VALUES ('project-a', 'work'), ('project-b', 'work'); INSERT INTO project_aliases VALUES ('alias-a', 'project-a');");
  database.close();
  const nonce = `${tag}-${Date.now()}-${Math.random()}`;
  return { dataDir, secrets: await import(`../src/secrets.js?${nonce}`), browser: await import(`../src/browser-agent.js?${nonce}`) };
}

async function useFixture(tag: string, body: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const previous = process.env.PI_WEB_DATA_DIR;
  let dataDir = "";
  try { const value = await fixture(tag); dataDir = value.dataDir; await body(value); }
  finally { if (previous === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previous; if (dataDir) await rm(dataDir, { recursive: true, force: true }); }
}

const variable = (value?: string) => ({ name: "LOGIN_PASSWORD", kind: "value" as const, ...(value === undefined ? {} : { value }) });

test("website origins are canonical metadata and website values never enter generic credentials", async () => {
  await useFixture("metadata", async ({ secrets }) => {
    const account = await secrets.saveSecretAccount({ label: "Site", provider: "custom", websiteOrigin: "https://EXAMPLE.com:443", variables: [variable("synthetic-secret")] });
    assert.equal(account.websiteOrigin, "https://example.com");
    assert.equal((await secrets.listSecretAccounts())[0].websiteOrigin, "https://example.com");
    await secrets.setScopeSecretAccounts("project", "alias-a", [account.id]);
    assert.deepEqual(secrets.genericSecretEnvironment("project-a"), {});
    const context = secrets.agentCredentialContext("project-a");
    assert.match(context, new RegExp(account.id));
    assert.match(context, /https:\/\/example\.com.*LOGIN_PASSWORD.*login-fill/);
    assert.doesNotMatch(context, /synthetic-secret|already exported/);

    const edited = await secrets.saveSecretAccount({ id: account.id, label: "Site edited", provider: "custom", variables: [variable()] });
    assert.equal(edited.websiteOrigin, "https://example.com");
    const unbound = await secrets.saveSecretAccount({ id: account.id, label: "Site edited", provider: "custom", websiteOrigin: null, variables: [variable()] });
    assert.equal(unbound.websiteOrigin, undefined);
    assert.equal(secrets.genericSecretEnvironment("project-a").LOGIN_PASSWORD, "synthetic-secret");
  });
});

test("website origin validation allows secure and loopback origins only", async () => {
  await useFixture("validation", async ({ secrets }) => {
    assert.equal(secrets.normalizeWebsiteOrigin("http://localhost:3000"), "http://localhost:3000");
    assert.equal(secrets.normalizeWebsiteOrigin("http://127.0.0.1"), "http://127.0.0.1");
    assert.equal(secrets.normalizeWebsiteOrigin("http://[::1]"), "http://[::1]");
    for (const origin of ["http://example.com", "https://u:p@example.com", "https://example.com/path", "https://example.com/?q=1", "https://example.com/#x"]) assert.throws(() => secrets.normalizeWebsiteOrigin(origin));
    await assert.rejects(() => secrets.saveSecretAccount({ label: "Bad", provider: "custom", websiteOrigin: "https://example.com", replicate: true, variables: [variable("x")] }), /replicate/i);
    await assert.rejects(() => secrets.saveSecretAccount({ label: "Bad", provider: "custom", websiteOrigin: "https://example.com", variables: [{ name: "FILE", kind: "file", value: "x" }] }), /file/i);
  });
});

test("website collisions are independent while ordinary collision rules remain", async () => {
  await useFixture("collision", async ({ secrets }) => {
    const first = await secrets.saveSecretAccount({ label: "One", provider: "custom", websiteOrigin: "https://one.example", variables: [variable("one")] });
    const second = await secrets.saveSecretAccount({ label: "Two", provider: "custom", websiteOrigin: "https://two.example", variables: [variable("two")] });
    await secrets.setScopeSecretAccounts("project", "project-a", [first.id, second.id]);
    const ordinary = await secrets.saveSecretAccount({ label: "Ordinary", provider: "custom", variables: [variable("ordinary")] });
    await secrets.setScopeSecretAccounts("project", "project-a", [first.id, second.id, ordinary.id]);
    const duplicate = await secrets.saveSecretAccount({ label: "Duplicate", provider: "custom", variables: [variable("duplicate")] });
    await assert.rejects(() => secrets.setScopeSecretAccounts("project", "project-a", [ordinary.id, duplicate.id]), /duplicate environment variable/);
  });
});

test("website credentials merge per variable and exact origin across scopes", async () => {
  await useFixture("resolution", async ({ secrets }) => {
    const websiteVariable = (name: string, value: string) => ({ name, kind: "value" as const, value });
    const workspace = await secrets.saveSecretAccount({ label: "workspace site", provider: "custom", websiteOrigin: "https://example.com", variables: [
      websiteVariable("USER", "workspace-user"), websiteVariable("PASSWORD", "workspace-password"), websiteVariable("TENANT", "workspace-tenant"),
    ] });
    const project = await secrets.saveSecretAccount({ label: "project site", provider: "custom", websiteOrigin: "https://example.com", variables: [websiteVariable("PASSWORD", "project-password")] });
    const conversation = await secrets.saveSecretAccount({ label: "conversation site", provider: "custom", websiteOrigin: "https://example.com", variables: [websiteVariable("TENANT", "conversation-tenant")] });
    const unrelated = await secrets.saveSecretAccount({ label: "other site", provider: "custom", websiteOrigin: "https://other.example", variables: [websiteVariable("USER", "other-user")] });
    await secrets.setScopeSecretAccounts("workspace", "work", [workspace.id, unrelated.id]);
    await secrets.setScopeSecretAccounts("project", "project-a", [project.id]);
    await secrets.setScopeSecretAccounts("conversation", "pi:one", [conversation.id]);

    assert.deepEqual(secrets.websiteCredentialSnapshot("project-a", { engine: "pi", sessionId: "one" }).sort((left, right) => left.origin.localeCompare(right.origin)), [
      { id: conversation.id, origin: "https://example.com", variables: [websiteVariable("USER", "workspace-user"), websiteVariable("PASSWORD", "project-password"), websiteVariable("TENANT", "conversation-tenant")] },
      { id: unrelated.id, origin: "https://other.example", variables: [websiteVariable("USER", "other-user")] },
    ]);
    assert.deepEqual(secrets.websiteCredentialSnapshot("project-a", { engine: "pi", sessionId: "two" }).find((entry) => entry.origin === "https://example.com"), {
      id: project.id, origin: "https://example.com", variables: [websiteVariable("USER", "workspace-user"), websiteVariable("PASSWORD", "project-password"), websiteVariable("TENANT", "workspace-tenant")],
    });
    assert.deepEqual(secrets.websiteCredentialSnapshot("project-b").sort((left, right) => left.origin.localeCompare(right.origin)).map(({ id, origin }) => ({ id, origin })), [
      { id: workspace.id, origin: "https://example.com" }, { id: unrelated.id, origin: "https://other.example" },
    ]);

    const context = secrets.agentCredentialContext("project-a", { engine: "pi", sessionId: "one" });
    assert.match(context, new RegExp(`account ${conversation.id}.*USER, PASSWORD, TENANT.*login-fill`));
    assert.match(context, new RegExp(`account ${unrelated.id}.*USER.*login-fill`));
    assert.doesNotMatch(context, new RegExp(`${workspace.id}|${project.id}|workspace-user|project-password|conversation-tenant|other-user|already exported`));
  });
});

test("duplicate website origins are rejected within one scope and when editing", async () => {
  await useFixture("duplicate-origin", async ({ secrets }) => {
    const first = await secrets.saveSecretAccount({ label: "One", provider: "custom", websiteOrigin: "https://one.example", variables: [variable("one-secret")] });
    const second = await secrets.saveSecretAccount({ label: "Two", provider: "custom", websiteOrigin: "https://two.example", variables: [variable("two-secret")] });
    const duplicate = await secrets.saveSecretAccount({ label: "Duplicate", provider: "custom", websiteOrigin: "https://ONE.example:443", variables: [variable("duplicate-secret")] });
    await assert.rejects(() => secrets.setScopeSecretAccounts("project", "project-a", [first.id, duplicate.id]), /Selected website accounts have duplicate origins/);

    await secrets.setScopeSecretAccounts("project", "project-a", [first.id, second.id]);
    await assert.rejects(() => secrets.saveSecretAccount({ id: second.id, label: "Changed", provider: "custom", websiteOrigin: "https://one.example", variables: [variable("changed-secret")] }), /Selected website accounts have duplicate origins/);
    const unchanged = (await secrets.listSecretAccounts()).find(({ id }) => id === second.id);
    assert.equal(unchanged?.label, "Two");
    assert.equal(unchanged?.websiteOrigin, "https://two.example");
    assert.equal(secrets.websiteCredentialSnapshot("project-a").find(({ id }) => id === second.id)?.variables[0].value, "two-secret");
  });
});

test("browser tokens hold immutable encrypted scope snapshots", async () => {
  await useFixture("snapshot", async ({ dataDir, secrets, browser }) => {
    const account = await secrets.saveSecretAccount({ label: "Site", provider: "custom", websiteOrigin: "https://example.com", variables: [variable("old-value")] });
    await secrets.setScopeSecretAccounts("project", "project-a", [account.id]);
    await secrets.setScopeSecretAccounts("conversation", "pi:one", [account.id]);
    const first = browser.browserAgentEnvironment("project-a", "pi", "logical", secrets.websiteCredentialSnapshot("project-a", { engine: "pi", sessionId: "one" }));
    await secrets.saveSecretAccount({ id: account.id, label: "Site", provider: "custom", websiteOrigin: "https://example.com", variables: [variable("new-value")] });
    const second = browser.browserAgentEnvironment("project-a", "pi", "logical", secrets.websiteCredentialSnapshot("project-a", { engine: "pi", sessionId: "one" }));
    assert.deepEqual(browser.browserAgentCredential(first.JOINT_BOB_BROWSER_TOKEN!, account.id, "LOGIN_PASSWORD"), { origin: "https://example.com", value: "old-value" });
    assert.deepEqual(browser.browserAgentCredential(second.JOINT_BOB_BROWSER_TOKEN!, account.id, "LOGIN_PASSWORD"), { origin: "https://example.com", value: "new-value" });
    await secrets.setScopeSecretAccounts("project", "project-a", []);
    await secrets.setScopeSecretAccounts("conversation", "pi:one", []);
    const removed = browser.browserAgentEnvironment("project-a", "pi", "logical", secrets.websiteCredentialSnapshot("project-a", { engine: "pi", sessionId: "one" }));
    assert.throws(() => browser.browserAgentCredential(removed.JOINT_BOB_BROWSER_TOKEN!, account.id, "LOGIN_PASSWORD"), /credential/i);
    assert.deepEqual(secrets.websiteCredentialSnapshot("project-b", { engine: "pi", sessionId: "two" }), []);
    const database = new DatabaseSync(path.join(dataDir, "node.db"));
    const rows = database.prepare("SELECT credentials_encrypted FROM browser_agent_tokens").all();
    database.close();
    assert.ok(rows.some((row) => (row as { credentials_encrypted: string | null }).credentials_encrypted));
    assert.doesNotMatch(JSON.stringify(rows), /old-value|new-value/);
  });
});

test("the website provider requires an origin and keeps its structured login variables out of the shell", async () => {
  await useFixture("provider", async ({ secrets }) => {
    // A website-provider account cannot be saved without an origin, unlike an ordinary custom account.
    await assert.rejects(() => secrets.saveSecretAccount({ label: "No origin", provider: "website", variables: [
      { name: "LOGIN_USERNAME", kind: "value" as const, value: "user" }, { name: "LOGIN_PASSWORD", kind: "value" as const, value: "pass" },
    ] }), /website origin/i);
    // Clearing the origin on an existing website account is rejected for the same reason.
    const account = await secrets.saveSecretAccount({ label: "Login", provider: "website", websiteOrigin: "https://app.example.com", variables: [
      { name: "LOGIN_USERNAME", kind: "value" as const, value: "user" }, { name: "LOGIN_PASSWORD", kind: "value" as const, value: "synthetic-pass" },
    ] });
    assert.equal(account.provider, "website");
    assert.equal(account.websiteOrigin, "https://app.example.com");
    await assert.rejects(() => secrets.saveSecretAccount({ id: account.id, label: "Login", provider: "website", websiteOrigin: null, variables: [
      { name: "LOGIN_USERNAME", kind: "value" as const, value: "user" }, { name: "LOGIN_PASSWORD", kind: "value" as const, value: "synthetic-pass" },
    ] }), /website origin/i);
    // Website accounts never replicate and never hold file variables.
    await assert.rejects(() => secrets.saveSecretAccount({ label: "Bad", provider: "website", websiteOrigin: "https://other.example", replicate: true, variables: [
      { name: "LOGIN_PASSWORD", kind: "value" as const, value: "x" },
    ] }), /replicate/i);
    await assert.rejects(() => secrets.saveSecretAccount({ label: "Bad", provider: "website", websiteOrigin: "https://other.example", variables: [
      { name: "LOGIN_PASSWORD", kind: "file" as const, value: "x" },
    ] }), /file/i);

    await secrets.setScopeSecretAccounts("project", "project-a", [account.id]);
    // The structured login is surfaced through the website snapshot / login-fill path, not the shell.
    assert.deepEqual(secrets.genericSecretEnvironment("project-a"), {});
    assert.deepEqual(secrets.websiteCredentialSnapshot("project-a"), [
      { id: account.id, origin: "https://app.example.com", variables: [
        { name: "LOGIN_USERNAME", kind: "value", value: "user" }, { name: "LOGIN_PASSWORD", kind: "value", value: "synthetic-pass" },
      ] },
    ]);
    const context = secrets.agentCredentialContext("project-a");
    assert.match(context, new RegExp(`website .*account ${account.id}.*https://app\\.example\\.com.*LOGIN_USERNAME, LOGIN_PASSWORD.*login-fill`));
    assert.doesNotMatch(context, /synthetic-pass|already exported/);
  });
});
