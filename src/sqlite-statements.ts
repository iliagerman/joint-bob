import { DatabaseSync, StatementSync } from "node:sqlite";

/**
 * Keeps each connection's compiled statements.
 *
 * Queries in this codebase call `db.prepare` where they run, so SQLite parsed and planned
 * the same text again on every call: on a busy node that was a seventh of all CPU time.
 * Importing this module makes `prepare` return the statement it compiled earlier for the
 * same text on the same connection.
 *
 * Sharing is safe for `get`, `all` and `run`, which finish and reset the statement before
 * they return. `iterate` keeps its statement open between rows, so it compiles its own.
 * SQLite recompiles a kept statement by itself when the schema changes under it.
 */
const MAX_STATEMENTS = 256;
const statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
const origins = new WeakMap<StatementSync, { db: DatabaseSync; sql: string }>();
const prepare = DatabaseSync.prototype.prepare;
const close = DatabaseSync.prototype.close;
const iterate = StatementSync.prototype.iterate;

DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string): StatementSync {
  if (typeof sql !== "string") return prepare.call(this, sql);
  let kept = statements.get(this);
  if (!kept) statements.set(this, kept = new Map());
  let statement = kept.get(sql);
  // Re-inserting keeps the map ordered by last use, so the oldest entry is the one to drop.
  if (statement) kept.delete(sql);
  else {
    statement = prepare.call(this, sql);
    origins.set(statement, { db: this, sql });
    if (kept.size >= MAX_STATEMENTS) kept.delete(kept.keys().next().value!);
  }
  kept.set(sql, statement);
  return statement;
};

StatementSync.prototype.iterate = function (this: StatementSync, ...parameters: unknown[]) {
  const origin = origins.get(this);
  return Reflect.apply(iterate, origin ? prepare.call(origin.db, origin.sql) : this, parameters);
} as StatementSync["iterate"];

// Closing finalizes every statement of the connection; a reopened one must compile afresh.
DatabaseSync.prototype.close = function (this: DatabaseSync): void {
  statements.delete(this);
  close.call(this);
};
