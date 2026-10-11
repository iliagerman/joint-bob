import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import "../src/sqlite-statements.js";

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
