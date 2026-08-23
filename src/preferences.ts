import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface UserPreferences {
  theme: "light" | "dark" | null;
  notificationsEnabled: boolean;
  completionSound: "off" | "chime" | "bell";
  installDismissed: boolean;
  mobileView: "projects" | "sessions" | "board" | "chat";
  activeProjectId: string | null;
  activeSessionPath: string | null;
  activeSessionId: string | null;
  activeNodeId: string | null;
  legacyMigrated: boolean;
}

interface PreferenceRow {
  theme: UserPreferences["theme"];
  notifications_enabled: number;
  completion_sound: UserPreferences["completionSound"];
  install_dismissed: number;
  mobile_view: UserPreferences["mobileView"];
  active_project_id: string | null;
  active_session_path: string | null;
  active_session_id: string | null;
  active_node_id: string | null;
  legacy_migrated: number;
}

const dataDir = process.env.JOINT_BOB_DATA_DIR ?? process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob");
const databasePath = path.join(dataDir, "node.db");
let database: DatabaseSync | undefined;

function preferencesDatabase(): DatabaseSync {
  if (database) return database;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      theme TEXT,
      notifications_enabled INTEGER NOT NULL DEFAULT 0,
      completion_sound TEXT NOT NULL DEFAULT 'chime',
      install_dismissed INTEGER NOT NULL DEFAULT 0,
      mobile_view TEXT NOT NULL DEFAULT 'projects',
      active_project_id TEXT,
      active_session_path TEXT,
      active_session_id TEXT,
      active_node_id TEXT,
      legacy_migrated INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);
  const columns = database.prepare("PRAGMA table_info(user_preferences)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "completion_sound")) database.exec("ALTER TABLE user_preferences ADD COLUMN completion_sound TEXT NOT NULL DEFAULT 'chime'");
  if (!columns.some((column) => column.name === "active_session_id")) database.exec("ALTER TABLE user_preferences ADD COLUMN active_session_id TEXT");
  if (!columns.some((column) => column.name === "active_node_id")) database.exec("ALTER TABLE user_preferences ADD COLUMN active_node_id TEXT");
  return database;
}

function ensurePreferences(userId: string): void {
  preferencesDatabase().prepare(`
    INSERT INTO user_preferences (user_id, updated_at)
    VALUES (?, ?)
    ON CONFLICT(user_id) DO NOTHING
  `).run(userId, new Date().toISOString());
}

function preferencesFromRow(row: PreferenceRow): UserPreferences {
  return {
    theme: row.theme,
    notificationsEnabled: row.notifications_enabled === 1,
    completionSound: row.completion_sound,
    installDismissed: row.install_dismissed === 1,
    mobileView: row.mobile_view,
    activeProjectId: row.active_project_id,
    activeSessionPath: row.active_session_path,
    activeSessionId: row.active_session_id,
    activeNodeId: row.active_node_id,
    legacyMigrated: row.legacy_migrated === 1,
  };
}

function currentPreferences(userId: string): UserPreferences {
  const row = preferencesDatabase().prepare(`
    SELECT theme, notifications_enabled, completion_sound, install_dismissed, mobile_view,
      active_project_id, active_session_path, active_session_id, active_node_id, legacy_migrated
    FROM user_preferences WHERE user_id = ?
  `).get(userId) as unknown as PreferenceRow;
  return preferencesFromRow(row);
}

export function getUserPreferences(userId: string): UserPreferences {
  ensurePreferences(userId);
  return currentPreferences(userId);
}

export function updateUserPreferences(userId: string, partial: Partial<UserPreferences>): UserPreferences {
  const columns: string[] = [];
  const values: Array<string | number | null> = [];
  const fields: Array<[keyof UserPreferences, string, (value: never) => string | number | null]> = [
    ["theme", "theme", (value) => value as string | null],
    ["notificationsEnabled", "notifications_enabled", (value) => value ? 1 : 0],
    ["completionSound", "completion_sound", (value) => value as string],
    ["installDismissed", "install_dismissed", (value) => value ? 1 : 0],
    ["mobileView", "mobile_view", (value) => value as string],
    ["activeProjectId", "active_project_id", (value) => value as string | null],
    ["activeSessionPath", "active_session_path", (value) => value as string | null],
    ["activeSessionId", "active_session_id", (value) => value as string | null],
    ["activeNodeId", "active_node_id", (value) => value as string | null],
    ["legacyMigrated", "legacy_migrated", (value) => value ? 1 : 0],
  ];
  for (const [property, column, serialize] of fields) {
    if (partial[property] === undefined) continue;
    columns.push(`${column} = ?`);
    values.push(serialize(partial[property] as never));
  }

  const db = preferencesDatabase();
  db.exec("BEGIN");
  try {
    ensurePreferences(userId);
    if (columns.length) {
      db.prepare(`UPDATE user_preferences SET ${columns.join(", ")}, updated_at = ? WHERE user_id = ?`)
        .run(...values, new Date().toISOString(), userId);
    }
    const preferences = currentPreferences(userId);
    db.exec("COMMIT");
    return preferences;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
