import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

/** Builds the schema `secrets.ts` expects, then re-imports it with a cache-busting query so it
    builds a fresh DatabaseSync handle against this test's temp dir. */
async function loadSecrets(tag: string) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `joint-bob-secrets-${tag}-`));
  process.env.PI_WEB_DATA_DIR = dataDir;
  const database = new DatabaseSync(path.join(dataDir, "node.db"));
  database.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY); CREATE TABLE projects (id TEXT PRIMARY KEY, workspace_id TEXT); CREATE TABLE project_aliases (alias_id TEXT PRIMARY KEY, project_id TEXT);");
  database.exec("INSERT INTO workspaces VALUES ('work'); INSERT INTO projects VALUES ('project-a', 'work'); INSERT INTO project_aliases VALUES ('project-alias', 'project-a');");
  database.close();
  return { dataDir, ...(await import(`../src/secrets.js?${tag}=${Date.now()}-${Math.random()}`)) };
}

async function withSecrets(tag: string, body: (secrets: Awaited<ReturnType<typeof loadSecrets>>) => Promise<void>): Promise<void> {
  const previous = process.env.PI_WEB_DATA_DIR;
  let dataDir = "";
  try {
    const secrets = await loadSecrets(tag);
    dataDir = secrets.dataDir;
    await body(secrets);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previous;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }
}

test("secret accounts redact saved values, retain omitted edits, and expose only attached env", async () => {
  await withSecrets("aws", async (secrets) => {
    const account = await secrets.saveSecretAccount({ label: "AWS prod", provider: "aws", variables: [
      { name: "AWS_ACCESS_KEY_ID", kind: "value", value: " access-key " },
      { name: "AWS_SECRET_ACCESS_KEY", kind: "value", value: "secret-key" },
    ] });
    assert.deepEqual(await secrets.listSecretAccounts(), [{ ...account }]);
    // Replication is opt-in, so a new account stays on this node.
    assert.equal(account.replicate, false);

    // An account with no attachment is inert: it contributes nothing anywhere.
    assert.deepEqual(secrets.genericSecretEnvironment("project-a"), {});

    await secrets.saveSecretAccount({ id: account.id, label: "AWS prod", provider: "aws", variables: [
      { name: "AWS_ACCESS_KEY_ID", kind: "value" },
      { name: "AWS_SECRET_ACCESS_KEY", kind: "value", value: "" },
    ] });
    await secrets.setScopeSecretAccounts("project", "project-alias", [account.id]);
    const env = secrets.genericSecretEnvironment("project-a");
    assert.equal(env.AWS_ACCESS_KEY_ID, " access-key ");
    assert.equal(env.AWS_SECRET_ACCESS_KEY, "secret-key");
    // Resolution is deterministic: the same inputs give the same environment every time.
    assert.deepEqual(secrets.genericSecretEnvironment("project-a"), env);
    assert.deepEqual(await secrets.getScopeSecretAccounts("project", "project-a"), { accountIds: [account.id] });
  });
});

test("Google file secrets are private files and context never includes values", async () => {
  await withSecrets("google", async (secrets) => {
    const json = '{"type":"service_account"}\n';
    const account = await secrets.saveSecretAccount({ label: "Google", provider: "google", variables: [{ name: "GOOGLE_APPLICATION_CREDENTIALS", kind: "file", value: json }] });
    await secrets.setScopeSecretAccounts("project", "project-a", [account.id]);
    const filePath = secrets.genericSecretEnvironment("project-a").GOOGLE_APPLICATION_CREDENTIALS;
    assert.ok(filePath?.startsWith(path.join(secrets.dataDir, "secret-files", account.id)));
    assert.equal(await readFile(filePath, "utf8"), json);
    assert.equal((await stat(path.dirname(filePath))).mode & 0o777, 0o700);
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    const context = secrets.agentCredentialContext("project-a");
    assert.match(context, /Google/);
    assert.match(context, /GOOGLE_APPLICATION_CREDENTIALS \(secret file path\)/);
    assert.doesNotMatch(context, /service_account|secret-key/);
  });
});

test("resolution is most-specific-wins per variable name across the three scopes", async () => {
  await withSecrets("resolution", async (secrets) => {
    const workspace = await secrets.saveSecretAccount({ label: "workspace", provider: "custom", variables: [
      { name: "TOKEN", kind: "value", value: "workspace" },
      { name: "ONLY_WORKSPACE", kind: "value", value: "workspace-only" },
    ] });
    const project = await secrets.saveSecretAccount({ label: "project", provider: "custom", variables: [{ name: "TOKEN", kind: "value", value: "project" }] });
    const conversation = await secrets.saveSecretAccount({ label: "conversation", provider: "custom", variables: [{ name: "TOKEN", kind: "value", value: "conversation" }] });
    const session = { engine: "claude" as const, sessionId: "session-1" };

    await secrets.setScopeSecretAccounts("workspace", "work", [workspace.id]);
    assert.equal(secrets.genericSecretEnvironment("project-a").TOKEN, "workspace");

    await secrets.setScopeSecretAccounts("project", "project-a", [project.id]);
    assert.equal(secrets.genericSecretEnvironment("project-a").TOKEN, "project");

    await secrets.setScopeSecretAccounts("conversation", "claude:session-1", [conversation.id]);
    assert.equal(secrets.genericSecretEnvironment("project-a", session).TOKEN, "conversation");
    // A variable defined at one scope only still resolves, whatever the narrower scopes define.
    assert.equal(secrets.genericSecretEnvironment("project-a", session).ONLY_WORKSPACE, "workspace-only");
    // Another conversation in the same project is unaffected.
    assert.equal(secrets.genericSecretEnvironment("project-a", { engine: "claude", sessionId: "session-2" }).TOKEN, "project");

    // Two accounts at the same scope declaring the same name are rejected at attachment time.
    await assert.rejects(() => secrets.setScopeSecretAccounts("project", "project-a", [workspace.id, project.id]), /duplicate environment variable/);
  });
});

test("a GitHub token produces the whole git push contract, and no token produces none of it", async () => {
  await withSecrets("github", async (secrets) => {
    const github = await secrets.saveSecretAccount({ label: "Work GitHub", provider: "github", variables: [{ name: "GH_TOKEN", kind: "value", value: "ghp_test_alpha" }] });
    const aws = await secrets.saveSecretAccount({ label: "AWS prod", provider: "aws", variables: [{ name: "AWS_ACCESS_KEY_ID", kind: "value", value: "access-key" }] });

    // No GitHub account attached yet: none of the GitHub variables exist.
    await secrets.setScopeSecretAccounts("project", "project-a", [aws.id]);
    const withoutToken = secrets.genericSecretEnvironment("project-a");
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "PI_GITHUB_TOKEN", "GIT_ASKPASS", "GIT_TERMINAL_PROMPT"]) {
      assert.equal(withoutToken[name], undefined, name);
    }

    await secrets.setScopeSecretAccounts("project", "project-a", [github.id, aws.id]);
    const env = secrets.genericSecretEnvironment("project-a");
    assert.equal(env.GH_TOKEN, "ghp_test_alpha");
    assert.equal(env.GITHUB_TOKEN, "ghp_test_alpha");
    assert.equal(env.PI_GITHUB_TOKEN, "ghp_test_alpha");
    assert.equal(env.GIT_ASKPASS, path.join(secrets.dataDir, "github-askpass.sh"));
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal((await stat(env.GIT_ASKPASS)).mode & 0o777, 0o700);
    assert.equal(env.AWS_ACCESS_KEY_ID, "access-key");

    const context = secrets.agentCredentialContext("project-a");
    assert.match(context, /gh CLI/);
    assert.match(context, /AWS CLI/);
    assert.doesNotMatch(context, /ghp_test_alpha|access-key/);

    // The provider owns its variable name, so a typo cannot silently disable git push.
    await assert.rejects(() => secrets.saveSecretAccount({ label: "Typo", provider: "github", variables: [{ name: "GH_TOKEEN", kind: "value", value: "ghp_test_beta" }] }), /exactly one GH_TOKEN/);
  });
});

test("a conversation carries the accounts picked before its session id exists", async () => {
  await withSecrets("pending", async (secrets) => {
    const account = await secrets.saveSecretAccount({ label: "picked", provider: "custom", variables: [{ name: "TOKEN", kind: "value", value: "picked" }] });

    // The environment is composed once, at spawn, before the engine reports an id.
    const env = secrets.agentEnvironment("project-a", { engine: "pi", accountIds: [account.id] });
    assert.equal(env.TOKEN, "picked");

    await secrets.persistConversationSecretAccounts("pi", "session-9", [account.id]);
    assert.deepEqual(await secrets.getScopeSecretAccounts("conversation", "pi:session-9"), { accountIds: [account.id] });
    // Re-resolving after the id lands gives the same answer, with no duplicate.
    assert.equal(secrets.agentEnvironment("project-a", { engine: "pi", sessionId: "session-9", accountIds: [account.id] }).TOKEN, "picked");
  });
});

test("deleting an account removes its attachments and a dangling attachment is ignored", async () => {
  await withSecrets("cleanup", async (secrets) => {
    const workspace = await secrets.saveSecretAccount({ label: "workspace", provider: "custom", variables: [{ name: "WORKSPACE_TOKEN", kind: "value", value: "workspace" }] });
    const project = await secrets.saveSecretAccount({ label: "project", provider: "custom", variables: [{ name: "PROJECT_TOKEN", kind: "value", value: "project" }] });
    await secrets.setScopeSecretAccounts("workspace", "work", [workspace.id]);
    await secrets.setScopeSecretAccounts("project", "project-a", [project.id]);
    await secrets.setScopeSecretAccounts("conversation", "pi:session-1", [project.id]);

    await secrets.deleteSecretAccount(project.id);
    // Every attachment of the deleted account is gone, at every scope.
    assert.deepEqual(await secrets.getScopeSecretAccounts("project", "project-a"), { accountIds: [] });
    assert.deepEqual(await secrets.getScopeSecretAccounts("conversation", "pi:session-1"), { accountIds: [] });

    // A row left pointing at a missing account never blocks the remaining scopes.
    const database = new DatabaseSync(path.join(secrets.dataDir, "node.db"));
    database.prepare("INSERT INTO secret_assignments (scope_type, scope_id, account_id) VALUES ('project', 'project-a', ?)").run("00000000-0000-4000-8000-000000000000");
    database.close();
    assert.equal(secrets.genericSecretEnvironment("project-a").WORKSPACE_TOKEN, "workspace");
  });
});

test("deleting a project or a workspace deletes its attachments, and an alias merge re-keys them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-secrets-lifecycle-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = root;
  try {
    const tag = `${Date.now()}-${Math.random()}`;
    const store = await import(`../src/store.js?lifecycle=${tag}`);
    const secrets = await import(`../src/secrets.js?lifecycle=${tag}`);
    const account = await secrets.saveSecretAccount({ label: "shared", provider: "custom", variables: [{ name: "TOKEN", kind: "value", value: "shared" }] });

    const canonical = await store.addProject("Canonical", path.join(root, "canonical"), { type: "work" });
    const merged = await store.addProject("Merged", path.join(root, "merged"), { type: "work" });
    await secrets.setScopeSecretAccounts("project", merged.id, [account.id]);
    await secrets.setScopeSecretAccounts("workspace", "work", [account.id]);

    // An alias merge must carry the attachment across, or the merged project loses its credentials.
    await store.removeProject(merged.id);
    await store.registerProjectAliases(canonical.id, [merged.id]);
    assert.deepEqual(await secrets.getScopeSecretAccounts("project", canonical.id), { accountIds: [] });

    await secrets.setScopeSecretAccounts("project", canonical.id, [account.id]);
    await store.removeProject(canonical.id);
    const database = new DatabaseSync(path.join(root, "node.db"));
    try {
      assert.equal((database.prepare("SELECT COUNT(*) AS total FROM secret_assignments WHERE scope_type = 'project'").get() as { total: number }).total, 0);
      await store.deleteWorkspace("work");
      assert.equal((database.prepare("SELECT COUNT(*) AS total FROM secret_assignments WHERE scope_type = 'workspace'").get() as { total: number }).total, 0);
    } finally {
      database.close();
    }
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
