import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const exec = promisify(execFile);

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

test("new provider types retain encrypted values and export their chosen variable", async () => {
  await withSecrets("more-providers", async (secrets) => {
    for (const [provider, variable] of [
      ["openai", "OPENAI_API_KEY"], ["zai", "ZAI_API_KEY"], ["grafana", "GRAFANA_API_KEY"],
      ["datadog", "DD_API_KEY"], ["postgres", "DATABASE_URL"],
      ["mssql", "MSSQL_CONNECTION_STRING"], ["mongodb", "MONGODB_URI"],
    ] as const) {
      const account = await secrets.saveSecretAccount({ label: provider, provider, variables: [{ name: variable, kind: "value", value: `synthetic-${provider}` }] });
      await secrets.setScopeSecretAccounts("project", "project-a", [account.id]);
      assert.equal(secrets.genericSecretEnvironment("project-a")[variable], `synthetic-${provider}`);
      assert.match(secrets.agentCredentialContext("project-a"), new RegExp(provider));
      assert.doesNotMatch(JSON.stringify(await secrets.listSecretAccounts()), new RegExp(`synthetic-${provider}`));
    }
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
    await assert.rejects(() => secrets.saveSecretAccount({ label: "Typo", provider: "github", variables: [{ name: "GH_TOKEEN", kind: "value", value: "ghp_test_beta" }] }), /GitHub secret accounts hold only/);
  });
});

async function sshKeyPair(passphrase = ""): Promise<{ privateKey: string; publicKey: string; fingerprint: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jb-test-ssh-"));
  const file = path.join(directory, "key");
  await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", passphrase, "-C", "test", "-f", file]);
  const fingerprint = (await exec("ssh-keygen", ["-l", "-f", `${file}.pub`])).stdout.split(" ")[1];
  return { privateKey: await readFile(file, "utf8"), publicKey: (await readFile(`${file}.pub`, "utf8")).trim(), fingerprint, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

/** Runs git with only this test's config, so the developer's own credentials never answer. */
async function isolatedGit(env: NodeJS.ProcessEnv, home: string, args: string[], input?: string): Promise<string> {
  const child = execFile("git", args, { env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", ...env } });
  if (input !== undefined) child.stdin!.end(input);
  let stdout = "";
  child.stdout!.on("data", (chunk) => { stdout += chunk; });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(code, 0, `git ${args.join(" ")} failed`);
  return stdout;
}

test("a GitHub account with an SSH key routes its alias and owners through a generated ssh config", async () => {
  const pair = await sshKeyPair();
  try {
    await withSecrets("github-ssh", async (secrets) => {
      const account = await secrets.saveSecretAccount({ label: "Work GitHub", provider: "github", variables: [
        { name: "GH_TOKEN", kind: "value", value: "ghp_work" },
        { name: "GITHUB_SSH_KEY", kind: "file", value: pair.privateKey.replace(/\n/g, "\r\n").trim() },
        { name: "GITHUB_SSH_HOST", kind: "value", value: "work" },
        { name: "GITHUB_OWNERS", kind: "value", value: "acme, widgets" },
        { name: "GITHUB_GIT_PROTOCOL", kind: "value", value: "ssh" },
      ] });
      assert.deepEqual(account.github, { sshHost: "work", owners: ["acme", "widgets"], protocol: "ssh", hasToken: true, hasSshKey: true, publicKey: pair.publicKey, fingerprint: pair.fingerprint });
      assert.doesNotMatch(JSON.stringify(await secrets.listSecretAccounts()), /PRIVATE KEY|ghp_work/);

      await secrets.setScopeSecretAccounts("project", "project-a", [account.id]);
      const env = secrets.genericSecretEnvironment("project-a");
      assert.equal(env.GH_TOKEN, "ghp_work");
      assert.equal(env.GITHUB_SSH_KEY, undefined);
      const config = env.GIT_SSH_COMMAND!.match(/^ssh -F '(.+)'$/)![1];
      const resolved = (await exec("ssh", ["-G", "-F", config, "work"])).stdout;
      assert.match(resolved, /^hostname github\.com$/m);
      assert.match(resolved, /^identitiesonly yes$/m);
      assert.match(resolved, /^stricthostkeychecking (yes|true)$/m);
      const keyFile = resolved.match(/^identityfile (.+)$/m)![1];
      assert.equal(await readFile(keyFile, "utf8"), pair.privateKey);
      assert.equal((await stat(keyFile)).mode & 0o777, 0o600);
      assert.match(await readFile(resolved.match(/^userknownhostsfile (\S+)/m)![1], "utf8"), /^github\.com ssh-ed25519 /);

      const home = await mkdtemp(path.join(os.tmpdir(), "jb-test-home-"));
      try {
        await isolatedGit({}, home, ["init", "-q", home]);
        for (const [name, url] of [["https", "https://github.com/acme/app.git"], ["scp", "git@github.com:widgets/lib.git"], ["other", "https://github.com/someone/else.git"]]) await isolatedGit({}, home, ["-C", home, "remote", "add", name, url]);
        const url = async (name: string) => (await isolatedGit(env, home, ["-C", home, "remote", "get-url", name])).trim();
        assert.equal(await url("https"), "git@work:acme/app.git");
        assert.equal(await url("scp"), "git@work:widgets/lib.git");
        assert.equal(await url("other"), "https://github.com/someone/else.git");
      } finally { await rm(home, { recursive: true, force: true }); }

      const context = secrets.agentCredentialContext("project-a");
      assert.match(context, /SSH key SHA256:\S+ on host work/);
      assert.match(context, /owned by acme, widgets/);
      assert.doesNotMatch(context, /ghp_work|PRIVATE KEY/);

      // An edit that omits the key value keeps the saved key.
      const edited = await secrets.saveSecretAccount({ id: account.id, label: "Work GitHub", provider: "github", variables: [{ name: "GITHUB_SSH_KEY", kind: "file" }, { name: "GITHUB_GIT_PROTOCOL", kind: "value", value: "ssh" }] });
      assert.deepEqual(edited.github, { sshHost: "github.com", owners: [], protocol: "ssh", hasToken: false, hasSshKey: true, publicKey: pair.publicKey, fingerprint: pair.fingerprint });
    });
  } finally { await pair.cleanup(); }
});

test("GitHub SSH keys must be complete, unencrypted, and match the chosen git protocol", async () => {
  const locked = await sshKeyPair("hunter2-passphrase");
  try {
    await withSecrets("github-ssh-invalid", async (secrets) => {
      const save = (variables: Array<{ name: string; kind: "value" | "file"; value?: string }>) => secrets.saveSecretAccount({ label: "GitHub", provider: "github", variables });
      await assert.rejects(save([{ name: "GITHUB_SSH_KEY", kind: "file", value: locked.privateKey }]), /passphrase/);
      await assert.rejects(save([{ name: "GITHUB_SSH_KEY", kind: "file", value: "ssh-ed25519 AAAA public-key-instead" }]), /whole private SSH key/);
      await assert.rejects(save([{ name: "GH_TOKEN", kind: "value", value: "ghp_x" }, { name: "GITHUB_GIT_PROTOCOL", kind: "value", value: "ssh" }]), /needs an SSH key/);
      await assert.rejects(save([{ name: "GH_TOKEN", kind: "value", value: "ghp_x" }, { name: "GITHUB_OWNERS", kind: "value", value: "bad/owner" }]), /owner "bad\/owner" is invalid/);
      await assert.rejects(save([{ name: "GITHUB_SSH_HOST", kind: "value", value: "work" }]), /API token, an SSH key, or both/);
    });
  } finally { await locked.cleanup(); }
});

test("two GitHub token accounts each answer git for the owners they serve", async () => {
  await withSecrets("github-two", async (secrets) => {
    const alpha = await secrets.saveSecretAccount({ label: "Alpha", provider: "github", variables: [{ name: "GH_TOKEN", kind: "value", value: "ghp_alpha" }, { name: "GITHUB_OWNERS", kind: "value", value: "alpha-org" }] });
    const beta = await secrets.saveSecretAccount({ label: "Beta", provider: "github", variables: [{ name: "GH_TOKEN", kind: "value", value: "ghp_beta" }, { name: "GITHUB_OWNERS", kind: "value", value: "Beta-Org" }, { name: "GITHUB_SSH_HOST", kind: "value", value: "beta" }] });
    const clash = await secrets.saveSecretAccount({ label: "Clash", provider: "github", variables: [{ name: "GH_TOKEN", kind: "value", value: "ghp_clash" }, { name: "GITHUB_OWNERS", kind: "value", value: "alpha-org" }] });
    await assert.rejects(secrets.setScopeSecretAccounts("project", "project-a", [alpha.id, clash.id]), /both serve owner alpha-org/);
    await secrets.setScopeSecretAccounts("project", "project-a", [alpha.id, beta.id]);
    const env = secrets.genericSecretEnvironment("project-a");
    assert.equal(env.GIT_SSH_COMMAND, undefined);

    const home = await mkdtemp(path.join(os.tmpdir(), "jb-test-home-"));
    try {
      // A credential store configured elsewhere must not answer for routed GitHub owners.
      await writeFile(path.join(home, ".git-credentials"), "https://stale:ghp_stale@github.com\n", { mode: 0o600 });
      await writeFile(path.join(home, ".gitconfig"), "[credential]\n\thelper = store\n");
      const fill = async (repoPath: string) => (await isolatedGit(env, home, ["credential", "fill"], `protocol=https\nhost=github.com\npath=${repoPath}\n\n`)).match(/^password=(.+)$/m)?.[1];
      assert.equal(await fill("beta-org/repo.git"), "ghp_beta");
      assert.equal(await fill("alpha-org/repo.git"), "ghp_alpha");
      assert.ok(["ghp_alpha", "ghp_beta"].includes((await fill("unlisted/repo.git"))!));

      await isolatedGit({}, home, ["init", "-q", home]);
      await isolatedGit({}, home, ["-C", home, "remote", "add", "origin", "git@beta:Beta-Org/app.git"]);
      assert.equal((await isolatedGit(env, home, ["-C", home, "remote", "get-url", "origin"])).trim(), "https://github.com/Beta-Org/app.git");
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});

test("Stripe API keys are redacted and exported only for attached projects", async () => {
  await withSecrets("stripe", async (secrets) => {
    const account = await secrets.saveSecretAccount({ label: "Stripe test", provider: "stripe", variables: [{ name: "STRIPE_API_KEY", kind: "value", value: "sk_test_synthetic" }] });
    assert.deepEqual((await secrets.listSecretAccounts()).find((item) => item.id === account.id), account);
    assert.equal(secrets.genericSecretEnvironment("project-a").STRIPE_API_KEY, undefined);
    await secrets.setScopeSecretAccounts("project", "project-a", [account.id]);
    assert.equal(secrets.genericSecretEnvironment("project-a").STRIPE_API_KEY, "sk_test_synthetic");
    const context = secrets.agentCredentialContext("project-a");
    assert.match(context, /stripe.*STRIPE_API_KEY.*Stripe CLI or SDK/);
    assert.doesNotMatch(context, /sk_test_synthetic/);
    await assert.rejects(() => secrets.saveSecretAccount({ label: "Typo", provider: "stripe", variables: [{ name: "STRIPE_KEY", kind: "value", value: "sk_test_other" }] }), /exactly one STRIPE_API_KEY/);
    await assert.rejects(() => secrets.saveSecretAccount({ label: "File", provider: "stripe", variables: [{ name: "STRIPE_API_KEY", kind: "file", value: "sk_test_other" }] }), /exactly one STRIPE_API_KEY/);
  });
});

test("Cloudflare API keys are redacted and exported only for attached projects", async () => {
  await withSecrets("cloudflare", async (secrets) => {
    const account = await secrets.saveSecretAccount({ label: "Cloudflare test", provider: "cloudflare", variables: [{ name: "CLOUDFLARE_API_KEY", kind: "value", value: "synthetic-cf-key" }] });
    assert.deepEqual((await secrets.listSecretAccounts()).find((item) => item.id === account.id), account);
    assert.equal(secrets.genericSecretEnvironment("project-a").CLOUDFLARE_API_KEY, undefined);
    await secrets.setScopeSecretAccounts("project", "project-a", [account.id]);
    assert.equal(secrets.genericSecretEnvironment("project-a").CLOUDFLARE_API_KEY, "synthetic-cf-key");
    const context = secrets.agentCredentialContext("project-a");
    assert.match(context, /cloudflare.*CLOUDFLARE_API_KEY.*Cloudflare API/);
    assert.doesNotMatch(context, /synthetic-cf-key/);
    await assert.rejects(() => secrets.saveSecretAccount({ label: "Typo", provider: "cloudflare", variables: [{ name: "CF_KEY", kind: "value", value: "other" }] }), /exactly one CLOUDFLARE_API_KEY/);
    await assert.rejects(() => secrets.saveSecretAccount({ label: "File", provider: "cloudflare", variables: [{ name: "CLOUDFLARE_API_KEY", kind: "file", value: "other" }] }), /exactly one CLOUDFLARE_API_KEY/);
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

test("project-owned accounts are attached on creation, keep their owner, and cannot replicate", async () => {
  await withSecrets("owned", async (secrets) => {
    // Created through an alias id, stored and attached under the canonical project id.
    const owned = await secrets.saveSecretAccount({ label: "Deploy key", provider: "custom", projectId: "project-alias", variables: [{ name: "DEPLOY_KEY", kind: "value", value: "deploy" }] });
    assert.equal(owned.projectId, "project-a");
    assert.deepEqual(await secrets.getScopeSecretAccounts("project", "project-a"), { accountIds: [owned.id] });
    assert.equal(secrets.genericSecretEnvironment("project-a").DEPLOY_KEY, "deploy");
    assert.deepEqual((await secrets.listSecretAccounts()).map((account) => account.projectId), ["project-a"]);

    // An edit cannot move the account to another owner or detach it from its project.
    const edited = await secrets.saveSecretAccount({ id: owned.id, label: "Deploy key 2", provider: "custom", projectId: "other", variables: [{ name: "DEPLOY_KEY", kind: "value" }] });
    assert.equal(edited.projectId, "project-a");
    assert.equal(edited.label, "Deploy key 2");

    // Owned accounts never leave this node, and never point at a project that does not exist.
    await assert.rejects(
      secrets.saveSecretAccount({ label: "Bad", provider: "custom", projectId: "project-a", replicate: true, variables: [{ name: "X", kind: "value", value: "x" }] }),
      (error: Error) => error.message === "Project-scoped secret accounts cannot replicate",
    );
    await assert.rejects(
      secrets.saveSecretAccount({ id: owned.id, label: "Bad", provider: "custom", replicate: true, variables: [{ name: "DEPLOY_KEY", kind: "value" }] }),
      (error: Error) => error.message === "Project-scoped secret accounts cannot replicate",
    );
    await assert.rejects(
      secrets.saveSecretAccount({ label: "Bad", provider: "custom", projectId: "missing", variables: [{ name: "X", kind: "value", value: "x" }] }),
      (error: Error) => error.message === "Secret project not found",
    );
    // A global account carries no owner at all.
    const global = await secrets.saveSecretAccount({ label: "Global", provider: "custom", variables: [{ name: "G", kind: "value", value: "g" }] });
    assert.equal("projectId" in global, false);
  });
});
