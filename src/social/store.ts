import type { DatabaseSync } from "node:sqlite";
import { clusterV2Database } from "../cluster-v2-store.js";

// Social records: discovery, groups, direct requests and public-action work.
// A group's host machine owns its members, invitations and messages; a direct thread lives
// on the assistant's execution machine. Other machines keep only an index of what is theirs.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS social_profiles (
  account_id TEXT PRIMARY KEY, default_assistant_id TEXT, description TEXT NOT NULL DEFAULT '',
  request_limit INTEGER NOT NULL DEFAULT 20, decision_limit INTEGER NOT NULL DEFAULT 200, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS social_discovery (
  account_id TEXT NOT NULL, subject_kind TEXT NOT NULL CHECK(subject_kind IN ('person','assistant')),
  subject_id TEXT NOT NULL, relay_node_id TEXT NOT NULL, PRIMARY KEY(subject_kind, subject_id, relay_node_id));
CREATE TABLE IF NOT EXISTS social_blocks (
  account_id TEXT NOT NULL, blocked_account_id TEXT NOT NULL, blocked_name TEXT NOT NULL, blocked_node_id TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY(account_id, blocked_account_id));

CREATE TABLE IF NOT EXISTS social_groups (
  id TEXT PRIMARY KEY, relay_node_id TEXT NOT NULL, name TEXT NOT NULL, creator_account_id TEXT NOT NULL,
  creator_node_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','closed')), next_seq INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS social_group_members (
  membership_id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES social_groups(id) ON DELETE CASCADE,
  member_kind TEXT NOT NULL CHECK(member_kind IN ('person','assistant')), member_id TEXT NOT NULL,
  account_id TEXT NOT NULL, node_id TEXT NOT NULL, name TEXT NOT NULL, owner_name TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '' CHECK(link IN ('','with','alone')), companion_of TEXT,
  start_seq INTEGER NOT NULL, end_seq INTEGER, status TEXT NOT NULL CHECK(status IN ('active','left','removed')),
  joined_at TEXT NOT NULL, left_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS social_one_active_membership ON social_group_members(group_id, member_kind, member_id) WHERE status='active';
CREATE TABLE IF NOT EXISTS social_invitations (
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES social_groups(id) ON DELETE CASCADE,
  invitee_kind TEXT NOT NULL CHECK(invitee_kind IN ('person','assistant')), invitee_id TEXT NOT NULL,
  invitee_account_id TEXT NOT NULL, invitee_node_id TEXT NOT NULL, invitee_name TEXT NOT NULL, owner_name TEXT NOT NULL DEFAULT '',
  invited_by_account_id TEXT NOT NULL, invited_by_name TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','accepted','declined','revoked','expired')),
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL, responded_at TEXT);
CREATE TABLE IF NOT EXISTS social_messages (
  group_id TEXT NOT NULL REFERENCES social_groups(id) ON DELETE CASCADE, seq INTEGER NOT NULL, id TEXT NOT NULL,
  author_membership_id TEXT, author_kind TEXT NOT NULL CHECK(author_kind IN ('person','assistant','system')),
  author_name TEXT NOT NULL, owner_name TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(group_id, seq), UNIQUE(group_id, id));

CREATE TABLE IF NOT EXISTS social_group_index (
  group_id TEXT NOT NULL, account_id TEXT NOT NULL, host_node_id TEXT NOT NULL, relay_node_id TEXT NOT NULL,
  name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','left','closed')), companion_name TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL, PRIMARY KEY(group_id, account_id));
CREATE TABLE IF NOT EXISTS social_assistant_groups (
  group_id TEXT NOT NULL, assistant_id TEXT NOT NULL, host_node_id TEXT NOT NULL, relay_node_id TEXT NOT NULL,
  name TEXT NOT NULL, cursor_seq INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL CHECK(status IN ('active','left','closed')),
  updated_at TEXT NOT NULL, PRIMARY KEY(group_id, assistant_id));
CREATE TABLE IF NOT EXISTS social_received_invitations (
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL, group_name TEXT NOT NULL, host_node_id TEXT NOT NULL, relay_node_id TEXT NOT NULL,
  invitee_kind TEXT NOT NULL, invitee_id TEXT NOT NULL, account_id TEXT NOT NULL, from_name TEXT NOT NULL,
  state TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, result TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS social_sent_invitations (
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL, group_name TEXT NOT NULL, account_id TEXT NOT NULL, invitee_name TEXT NOT NULL,
  state TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS social_outbox (
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL, account_id TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','sent','rejected')), error TEXT NOT NULL DEFAULT '');

CREATE TABLE IF NOT EXISTS social_threads (
  id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, requester_account_id TEXT NOT NULL, requester_node_id TEXT NOT NULL,
  requester_name TEXT NOT NULL, next_seq INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
  UNIQUE(assistant_id, requester_account_id));
CREATE TABLE IF NOT EXISTS social_thread_messages (
  thread_id TEXT NOT NULL REFERENCES social_threads(id) ON DELETE CASCADE, seq INTEGER NOT NULL, id TEXT NOT NULL,
  author TEXT NOT NULL CHECK(author IN ('requester','assistant')), text TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(thread_id, seq), UNIQUE(thread_id, id));
CREATE TABLE IF NOT EXISTS social_thread_index (
  thread_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, assistant_id TEXT NOT NULL, assistant_node_id TEXT NOT NULL,
  assistant_name TEXT NOT NULL, owner_name TEXT NOT NULL, relay_node_id TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(account_id, assistant_id));

CREATE TABLE IF NOT EXISTS social_actions (
  id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, inputs TEXT NOT NULL,
  instructions TEXT NOT NULL, operations TEXT NOT NULL, share_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('draft','published','disabled')), revision INTEGER NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS social_requests (
  id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, source_kind TEXT NOT NULL CHECK(source_kind IN ('group','thread')),
  source_id TEXT NOT NULL, source_name TEXT NOT NULL, message_id TEXT NOT NULL, caller_account_id TEXT NOT NULL,
  caller_name TEXT NOT NULL, caller_kind TEXT NOT NULL CHECK(caller_kind IN ('person','assistant')), text TEXT NOT NULL,
  state TEXT NOT NULL, action_id TEXT, action_revision INTEGER, instructions_digest TEXT, proposal TEXT, proposal_revision INTEGER NOT NULL DEFAULT 0,
  decision TEXT, receipt TEXT, detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(assistant_id, source_kind, source_id, message_id));
CREATE INDEX IF NOT EXISTS social_requests_recent ON social_requests(assistant_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS social_notices (
  id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, source_label TEXT NOT NULL,
  group_id TEXT, read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS social_usage (
  assistant_id TEXT NOT NULL, day TEXT NOT NULL, subject TEXT NOT NULL, count INTEGER NOT NULL,
  PRIMARY KEY(assistant_id, day, subject));
`;

let prepared: Promise<DatabaseSync> | undefined;

export function ensureSocialSchema(db: DatabaseSync): void { db.exec(SCHEMA); }

export async function socialDatabase(): Promise<DatabaseSync> {
  prepared ??= clusterV2Database().then(db => { ensureSocialSchema(db); return db; });
  return prepared;
}

/** Runs the callback in one IMMEDIATE transaction; membership changes and claims must not interleave. */
export function inTransaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = action(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

export const now = (): string => new Date().toISOString();
export const today = (): string => new Date().toISOString().slice(0, 10);
