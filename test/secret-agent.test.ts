import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "joint-bob-secret-agent-"));
process.env.PI_WEB_DATA_DIR = root;
const setup = new DatabaseSync(path.join(root, "node.db"));
setup.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY); CREATE TABLE projects (id TEXT PRIMARY KEY, workspace_id TEXT); CREATE TABLE project_aliases (alias_id TEXT PRIMARY KEY, project_id TEXT); INSERT INTO workspaces VALUES ('work'); INSERT INTO projects VALUES ('project-a','work'), ('project-b','work');");
setup.close();
const secrets = await import("../src/secrets.js");
const agent = await import("../src/secret-agent.js");

test("selects only attached accounts for one command without exposing values in metadata", async () => {
  try {
    const one = await secrets.saveSecretAccount({ label: "Dev AWS", provider: "aws", variables: [
      { name: "AWS_ACCESS_KEY_ID", kind: "value", value: "synthetic-dev-id" },
      { name: "AWS_SECRET_ACCESS_KEY", kind: "value", value: "synthetic-dev-secret" },
    ] });
    const two = await secrets.saveSecretAccount({ label: "Prod AWS", provider: "aws", variables: [
      { name: "AWS_ACCESS_KEY_ID", kind: "value", value: "synthetic-prod-id" },
      { name: "AWS_SECRET_ACCESS_KEY", kind: "value", value: "synthetic-prod-secret" },
    ] });
    const outside = await secrets.saveSecretAccount({ label: "Elsewhere", provider: "custom", variables: [{ name: "OTHER_TOKEN", kind: "value", value: "synthetic-other" }] });
    await secrets.setScopeSecretAccounts("workspace", "work", [one.id, two.id]);
    await secrets.setScopeSecretAccounts("conversation", "pi:only-this", [outside.id]);
    assert.equal(secrets.genericSecretEnvironment("project-a").AWS_ACCESS_KEY_ID, undefined);
    const { JOINT_BOB_SECRET_TOKEN: token, JOINT_BOB_SECRET_CLI: cli } = agent.secretAgentEnvironment("project-a", "pi", "another-session");
    assert.ok(token && cli);
    const listed = JSON.stringify(agent.secretAgentAccounts(token));
    assert.match(listed, /Dev AWS|Prod AWS/);
    assert.doesNotMatch(listed, /synthetic-/);
    assert.ok(!listed.includes(outside.id));
    assert.throws(() => agent.secretAgentAccountEnvironment(token, outside.id), /not available/);
    assert.throws(() => agent.secretAgentAccountEnvironment("wrong", one.id), /unavailable/);
    const selected = agent.secretAgentAccountEnvironment(token, two.id);
    assert.equal(selected.values.AWS_ACCESS_KEY_ID, "synthetic-prod-id");
    assert.equal(selected.values.AWS_SECRET_ACCESS_KEY, "synthetic-prod-secret");
    assert.ok(selected.removeNames.includes("AWS_SESSION_TOKEN"));
    assert.equal(agent.secretAgentAccountEnvironment(token, one.id).values.AWS_ACCESS_KEY_ID, "synthetic-dev-id");

    // The CLI adds the selected values to its child process, not to stdout or its parent.
    const child = spawnSync(process.execPath, [cli, "run", two.id, "--", process.execPath, "-e", "process.stdout.write(String(process.env.AWS_ACCESS_KEY_ID === 'synthetic-prod-id' && process.env.AWS_SECRET_ACCESS_KEY === 'synthetic-prod-secret' && !process.env.AWS_SESSION_TOKEN))"], {
      env: { HOME: root, PI_WEB_DATA_DIR: root, JOINT_BOB_SECRET_TOKEN: token, AWS_ACCESS_KEY_ID: "synthetic-dev-id", AWS_SECRET_ACCESS_KEY: "synthetic-dev-secret", AWS_SESSION_TOKEN: "old-session" }, encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "true");
    assert.doesNotMatch(child.stderr, /synthetic-/);
    const denied = spawnSync(process.execPath, [cli, "run", outside.id, "--", process.execPath, "-e", "process.stdout.write('ran')"], {
      env: { HOME: root, PI_WEB_DATA_DIR: root, JOINT_BOB_SECRET_TOKEN: token }, encoding: "utf8",
    });
    assert.equal(denied.status, 1);
    assert.doesNotMatch(denied.stdout, /ran/);
    await secrets.setScopeSecretAccounts("workspace", "work", [one.id]);
    assert.throws(() => agent.secretAgentAccountEnvironment(token, two.id), /not available/, "removing an attachment revokes existing tokens");
    const database = new DatabaseSync(path.join(root, "node.db"));
    database.prepare("UPDATE secret_agent_tokens SET expires_at=0").run();
    database.close();
    assert.throws(() => agent.secretAgentAccounts(token), /unavailable/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
