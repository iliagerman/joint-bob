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
  ensured.delete(this);
  close.call(this);
};

/**
 * Runs a "make sure these tables exist" script once per connection and schema.
 *
 * Some fifty helpers run `CREATE TABLE IF NOT EXISTS …` each time they are called, many of
 * them on every request, so SQLite parsed the same scripts thousands of times a minute to
 * learn again that nothing was missing. A script made only of `CREATE TABLE` and
 * `CREATE INDEX` statements with `IF NOT EXISTS` changes nothing unless the schema changed
 * since it last ran, and SQLite counts schema changes (`PRAGMA schema_version`, which any
 * connection's change advances). Such a script is skipped while that count stands still.
 *
 * Inside a transaction it always runs and is not remembered: a rollback can return the count
 * to a value seen before with the tables gone. Any other script runs as it always did.
 */
const exec = DatabaseSync.prototype.exec;
const ONLY_ENSURES = /^CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)\s+IF\s+NOT\s+EXISTS\s+[A-Za-z_][A-Za-z0-9_]*\s*(?:\(|ON\b)/i;
const ensuring = new Map<string, boolean>();
const ensured = new WeakMap<DatabaseSync, Map<string, number>>();

function onlyEnsures(sql: string): boolean {
  let known = ensuring.get(sql);
  if (known === undefined) {
    const parts = sql.split(";").map((part) => part.trim()).filter(Boolean);
    known = parts.length > 0 && parts.every((part) => ONLY_ENSURES.test(part));
    if (ensuring.size >= 1024) ensuring.clear();
    ensuring.set(sql, known);
  }
  return known;
}

DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string): void {
  if (typeof sql !== "string" || this.isTransaction !== false || !onlyEnsures(sql)) { exec.call(this, sql); return; }
  let ran = ensured.get(this);
  if (!ran) ensured.set(this, ran = new Map());
  const version = (): number => Number((this.prepare("PRAGMA schema_version").get() as { schema_version: number }).schema_version);
  if (ran.get(sql) === version()) { scripts.skipped++; return; }
  scripts.ran++;
  exec.call(this, sql);
  ran.set(sql, version());
};

const scripts = { ran: 0, skipped: 0 };
/** How many such scripts were run and how many were skipped, since this process started. */
export function ensureScriptCounts(): { ran: number; skipped: number } { return { ...scripts }; }
