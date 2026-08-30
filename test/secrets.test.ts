import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

async function loadSecrets(tag: string) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `joint-bob-secrets-${tag}-`));
  process.env.PI_WEB_DATA_DIR = dataDir;
  const database = new DatabaseSync(path.join(dataDir, "node.db"));
  database.exec("CREATE TABLE project_types (id TEXT PRIMARY KEY); CREATE TABLE projects (id TEXT PRIMARY KEY, project_type TEXT); CREATE TABLE project_aliases (alias_id TEXT PRIMARY KEY, project_id TEXT);");
  database.exec("INSERT INTO project_types VALUES ('work'); INSERT INTO projects VALUES ('project-a', 'work'); INSERT INTO project_aliases VALUES ('project-alias', 'project-a');");
  database.close();
  return { dataDir, ...(await import(`../src/secrets.js?${tag}=${Date.now()}-${Math.random()}`)) };
}

test("secret accounts redact saved values, retain omitted edits, and expose only assigned env", async () => {
  const previous = process.env.PI_WEB_DATA_DIR;
  let dataDir = "";
  try {
    const secrets = await loadSecrets("aws");
    dataDir = secrets.dataDir;
    const account = await secrets.saveSecretAccount({ label: "AWS prod", provider: "aws", variables: [
      { name: "AWS_ACCESS_KEY_ID", kind: "value", value: " access-key " },
      { name: "AWS_SECRET_ACCESS_KEY", kind: "value", value: "secret-key" },
    ] });
    assert.deepEqual(await secrets.listSecretAccounts(), [{ ...account }]);
    await secrets.saveSecretAccount({ id: account.id, label: "AWS prod", provider: "aws", variables: [
      { name: "AWS_ACCESS_KEY_ID", kind: "value" },
      { name: "AWS_SECRET_ACCESS_KEY", kind: "value", value: "" },
    ] });
    await secrets.setScopeSecretAccounts("project", "project-alias", [account.id]);
    const env = secrets.genericSecretEnvironment("project-a");
    assert.equal(env.AWS_ACCESS_KEY_ID, " access-key ");
    assert.equal(env.AWS_SECRET_ACCESS_KEY, "secret-key");
    assert.deepEqual(await secrets.getScopeSecretAccounts("project", "project-a"), { accountIds: [account.id] });
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previous;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }
});

test("Google file secrets are private files and context never includes values", async () => {
  const previous = process.env.PI_WEB_DATA_DIR;
  let dataDir = "";
  try {
    const secrets = await loadSecrets("google");
    dataDir = secrets.dataDir;
    const json = '{"type":"service_account"}\n';
    const account = await secrets.saveSecretAccount({ label: "Google", provider: "google", variables: [{ name: "GOOGLE_APPLICATION_CREDENTIALS", kind: "file", value: json }] });
    await secrets.setScopeSecretAccounts("project", "project-a", [account.id]);
    const filePath = secrets.genericSecretEnvironment("project-a").GOOGLE_APPLICATION_CREDENTIALS;
    assert.ok(filePath?.startsWith(path.join(dataDir, "secret-files", account.id)));
    assert.equal(await readFile(filePath, "utf8"), json);
    assert.equal((await stat(path.dirname(filePath))).mode & 0o777, 0o700);
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    const context = secrets.agentCredentialContext("project-a");
    assert.match(context, /Google/);
    assert.match(context, /GOOGLE_APPLICATION_CREDENTIALS \(secret file path\)/);
    assert.doesNotMatch(context, /service_account|secret-key/);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previous;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }
});

test("project types inherit accounts while direct accounts overwrite same names", async () => {
  const previous = process.env.PI_WEB_DATA_DIR;
  let dataDir = "";
  try {
    const secrets = await loadSecrets("inheritance");
    dataDir = secrets.dataDir;
    const inherited = await secrets.saveSecretAccount({ label: "type", provider: "custom", variables: [{ name: "TOKEN", kind: "value", value: "inherited" }] });
    const direct = await secrets.saveSecretAccount({ label: "direct", provider: "custom", variables: [{ name: "TOKEN", kind: "value", value: "direct" }] });
    await secrets.setScopeSecretAccounts("project_type", "work", [inherited.id]);
    assert.equal(secrets.genericSecretEnvironment("project-a").TOKEN, "inherited");
    await secrets.setScopeSecretAccounts("project", "project-a", [direct.id]);
    assert.equal(secrets.genericSecretEnvironment("project-a").TOKEN, "direct");
    await assert.rejects(() => secrets.setScopeSecretAccounts("project", "project-a", [inherited.id, direct.id]), /duplicate environment variable/);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previous;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }
});

test("secret scopes reject unknown targets and invalid scope types", async () => {
  const previous = process.env.PI_WEB_DATA_DIR;
  let dataDir = "";
  try {
    const secrets = await loadSecrets("invalid");
    dataDir = secrets.dataDir;
    await assert.rejects(() => secrets.getScopeSecretAccounts("project" as never, "missing"), /Secret project not found/);
    await assert.rejects(() => secrets.getScopeSecretAccounts("project_type" as never, "missing"), /Secret project type not found/);
    await assert.rejects(() => secrets.getScopeSecretAccounts("other" as never, "project-a"), /Secret scope type/);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previous;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }
});

test("GitHub secret accounts store an API token and the agent context explains each provider", async () => {
  const previous = process.env.PI_WEB_DATA_DIR;
  let dataDir = "";
  try {
    const secrets = await loadSecrets("github");
    dataDir = secrets.dataDir;
    const github = await secrets.saveSecretAccount({ label: "Work GitHub", provider: "github", variables: [
      { name: "GH_TOKEN", kind: "value", value: "ghp-token" },
    ] });
    const aws = await secrets.saveSecretAccount({ label: "AWS prod", provider: "aws", variables: [{ name: "AWS_ACCESS_KEY_ID", kind: "value", value: "access-key" }] });
    const google = await secrets.saveSecretAccount({ label: "GCP", provider: "google", variables: [{ name: "GOOGLE_APPLICATION_CREDENTIALS", kind: "file", value: '{"type":"service_account"}' }] });
    await secrets.setScopeSecretAccounts("project", "project-a", [github.id, aws.id, google.id]);
    const env = secrets.genericSecretEnvironment("project-a");
    assert.equal(env.GH_TOKEN, "ghp-token");
    // One pasted token has to satisfy both names, or half the GitHub tooling still prompts.
    assert.equal(env.GITHUB_TOKEN, "ghp-token");
    assert.equal(env.AWS_ACCESS_KEY_ID, "access-key");
    const context = secrets.agentCredentialContext("project-a");
    assert.match(context, /gh CLI/);
    assert.match(context, /AWS CLI/);
    assert.match(context, /gcloud/);
    assert.doesNotMatch(context, /ghp-token|access-key|service_account/);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previous;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }
});
