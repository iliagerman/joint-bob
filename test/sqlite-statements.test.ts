import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureScriptCounts } from "../src/sqlite-statements.js";

function fixture(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT UNIQUE); INSERT INTO items(name) VALUES('a'),('b'),('c')");
  return db;
}

test("the same query text is compiled once per connection", () => {
  const db = fixture(), other = fixture();
  const first = db.prepare("SELECT name FROM items WHERE id=?");
  assert.equal(db.prepare("SELECT name FROM items WHERE id=?"), first);
  assert.notEqual(db.prepare("SELECT name FROM items WHERE id = ?"), first, "different text is a different statement");
  assert.notEqual(other.prepare("SELECT name FROM items WHERE id=?"), first, "connections never share a statement");
  assert.deepEqual({ ...first.get(2) }, { name: "b" });
  assert.deepEqual({ ...db.prepare("SELECT name FROM items WHERE id=?").get(3) }, { name: "c" }, "a reused statement takes its new parameters");
});

test("a reused statement survives a failed run and a schema change", () => {
  const db = fixture();
  const insert = "INSERT INTO items(name) VALUES(?)";
  assert.throws(() => db.prepare(insert).run("a"), /UNIQUE/);
  assert.equal(db.prepare(insert).run("d").changes, 1, "the statement is usable after its error");
  const all = "SELECT * FROM items WHERE id=1";
  assert.deepEqual({ ...db.prepare(all).get() }, { id: 1, name: "a" });
  db.exec("ALTER TABLE items ADD COLUMN note TEXT DEFAULT 'none'");
  assert.deepEqual({ ...db.prepare(all).get() }, { id: 1, name: "a", note: "none" }, "the kept statement sees the new column");
  db.exec("DROP TABLE items");
  assert.throws(() => db.prepare(all).get(), /no such table/);
});

test("iterating compiles its own statement, so a nested use of the same query cannot reset it", () => {
  const db = fixture();
  const sql = "SELECT id FROM items ORDER BY id";
  const seen: number[] = [];
  for (const row of db.prepare(sql).iterate() as Iterable<{ id: number }>) {
    seen.push(row.id);
    assert.equal((db.prepare(sql).all() as unknown[]).length, 3);
    assert.equal([...db.prepare(sql).iterate()].length, 3);
  }
  assert.deepEqual(seen, [1, 2, 3]);
});

test("closing a connection drops its statements, and the least recently used are dropped first", () => {
  const db = new DatabaseSync(":memory:");
  const kept = db.prepare("SELECT 1 AS value");
  for (let index = 0; index < 300; index++) {
    db.prepare(`SELECT ${index} AS value`).get();
    assert.equal(db.prepare("SELECT 1 AS value"), kept, "a statement in use is never the oldest");
  }
  assert.deepEqual({ ...db.prepare("SELECT 299 AS value").get() }, { value: 299 });
  const dropped = db.prepare("SELECT 0 AS value");
  assert.deepEqual({ ...dropped.get() }, { value: 0 }, "a dropped query is simply compiled again");
  db.close();
  db.open();
  assert.notEqual(db.prepare("SELECT 1 AS value"), kept, "a reopened connection compiles afresh");
  assert.deepEqual({ ...db.prepare("SELECT 1 AS value").get() }, { value: 1 });
});

test("a script that only makes sure tables exist runs once, and again whenever the schema has changed", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jb-ensure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(root, "node.db")), other = new DatabaseSync(path.join(root, "node.db"));
  t.after(() => { db.close(); other.close(); });
  const ensure = "CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY, body TEXT);\n CREATE INDEX IF NOT EXISTS notes_body ON notes(body);";
  const counted = (run: () => void): { ran: number; skipped: number } => {
    const before = ensureScriptCounts();
    run();
    const after = ensureScriptCounts();
    return { ran: after.ran - before.ran, skipped: after.skipped - before.skipped };
  };
  const exists = (): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name='notes'").get());

  assert.deepEqual(counted(() => { for (let call = 0; call < 50; call++) db.exec(ensure); }), { ran: 1, skipped: 49 });
  db.prepare("INSERT INTO notes(body) VALUES('kept')").run();
  assert.deepEqual(counted(() => db.exec(ensure)), { ran: 0, skipped: 1 }, "writing rows is not a schema change");

  db.exec("DROP TABLE notes");
  assert.deepEqual(counted(() => db.exec(ensure)), { ran: 1, skipped: 0 }, "dropped on this connection");
  assert.equal(exists(), true);
  other.exec("DROP TABLE notes");
  assert.deepEqual(counted(() => db.exec(ensure)), { ran: 1, skipped: 0 }, "dropped by another connection");
  assert.equal(exists(), true);
  assert.deepEqual(counted(() => other.exec(ensure)), { ran: 1, skipped: 0 }, "each connection learns for itself");

  // A rollback takes the tables away again; nothing run inside a transaction is remembered.
  db.exec("DROP TABLE notes");
  db.exec("BEGIN");
  assert.deepEqual(counted(() => db.exec(ensure)), { ran: 0, skipped: 0 });
  db.exec("ROLLBACK");
  assert.equal(exists(), false);
  db.exec(ensure);
  assert.equal(exists(), true);
});

test("a script that does anything else runs every time", () => {
  const db = new DatabaseSync(":memory:");
  const before = ensureScriptCounts();
  for (let call = 0; call < 3; call++) db.exec("CREATE TABLE IF NOT EXISTS log(line TEXT); INSERT INTO log VALUES('started')");
  assert.equal((db.prepare("SELECT count(*) total FROM log").get() as { total: number }).total, 3);
  db.exec("CREATE TEMP TABLE IF NOT EXISTS scratch(x)");
  db.exec("ATTACH ':memory:' AS aside");
  for (let call = 0; call < 2; call++) db.exec("CREATE TABLE IF NOT EXISTS aside.items(x)");
  for (let call = 0; call < 2; call++) db.exec("CREATE TABLE IF NOT EXISTS copy AS SELECT * FROM log");
  assert.deepEqual(ensureScriptCounts(), before, "none of these is counted as a make-sure script");
});
