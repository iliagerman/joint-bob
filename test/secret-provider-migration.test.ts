import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { encryptSecretValue, ensureSecretSchema } from "../src/secrets.js";
import { ensureDedicatedSecretTypesMigration } from "../src/secrets-migration.js";

test("dedicated-provider migration changes only exact generic account provider types", () => {
  const db = new DatabaseSync(":memory:");
  ensureSecretSchema(db);
  db.exec("CREATE TABLE secrets_migrations (source TEXT PRIMARY KEY, migrated_at TEXT NOT NULL)");
  const insert = db.prepare(`INSERT INTO secret_accounts
    (id,label,provider,variables_encrypted,replicate,origin_node_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  const accounts = [
    ["typesafe", "TypeSafe AI", "custom", [{ name: "TYPESAFE_AI_API_KEY", kind: "value", value: "synthetic-typesafe" }]],
    ["tavily", "tavily", "custom", [{ name: "TAVILY_API_KEY", kind: "value", value: "synthetic-tavily" }]],
    ["elevenlabs", "ElevnLabs", "custom", [{ name: "ELEVENLABS_API_KEY", kind: "value", value: "synthetic-elevenlabs" }]],
    ["gitlab-api", "KMS Gitlab", "custom", [{ name: "GITLAB_API_KEY", kind: "value", value: "synthetic-gitlab" }]],
    ["mixed", "Mixed custom", "custom", [
      { name: "TYPESAFE_AI_API_KEY", kind: "value", value: "synthetic-mixed" },
      { name: "OTHER_VALUE", kind: "value", value: "synthetic-other" },
    ]],
  ] as const;
  for (const [id, label, provider, variables] of accounts) {
    insert.run(id, label, provider, encryptSecretValue(JSON.stringify(variables)), 1, "node-a", "created", "updated");
  }
  db.prepare("INSERT INTO secret_assignments VALUES ('project','project-a','typesafe')").run();
  const before = db.prepare("SELECT * FROM secret_accounts ORDER BY id").all();
  const assignmentsBefore = db.prepare("SELECT * FROM secret_assignments").all();

  ensureDedicatedSecretTypesMigration(db);

  const after = db.prepare("SELECT * FROM secret_accounts ORDER BY id").all() as Array<Record<string, unknown>>;
  assert.deepEqual(after.map(({ id, provider }) => [id, provider]), [
    ["elevenlabs", "elevenlabs"],
    ["gitlab-api", "gitlab"],
    ["mixed", "custom"],
    ["tavily", "tavily"],
    ["typesafe", "typesafe"],
  ]);
  for (const row of after) {
    const original = (before as Array<Record<string, unknown>>).find((candidate) => candidate.id === row.id)!;
    assert.equal(row.variables_encrypted, original.variables_encrypted);
    assert.equal(row.label, original.label);
    assert.equal(row.replicate, original.replicate);
    assert.equal(row.origin_node_id, original.origin_node_id);
    assert.equal(row.created_at, original.created_at);
    assert.equal(row.updated_at, original.updated_at);
  }
  assert.deepEqual(db.prepare("SELECT * FROM secret_assignments").all(), assignmentsBefore);
  const snapshot = JSON.stringify(after);
  ensureDedicatedSecretTypesMigration(db);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM secret_accounts ORDER BY id").all()), snapshot);
  db.close();
});
