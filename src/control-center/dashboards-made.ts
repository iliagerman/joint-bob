import type { DatabaseSync } from "node:sqlite";

/**
 * Which dashboards Bob made for the person, so the Dashboards tab can say "made by Bob". Kept with the
 * person's account on the node where Bob runs; the dashboard itself is the ordinary dashboard record.
 */
export function ensureMadeSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS control_center_bob_dashboards (
    dashboard_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, request TEXT NOT NULL, made_at TEXT NOT NULL)`);
}

export function recordBobDashboard(db: DatabaseSync, accountId: string, dashboardId: string, request: string): void {
  ensureMadeSchema(db);
  db.prepare("INSERT OR IGNORE INTO control_center_bob_dashboards (dashboard_id, account_id, request, made_at) VALUES (?, ?, ?, ?)")
    .run(dashboardId, accountId, request, new Date().toISOString());
}

export function bobDashboardIds(db: DatabaseSync, accountId: string): Set<string> {
  ensureMadeSchema(db);
  const rows = db.prepare("SELECT dashboard_id AS id FROM control_center_bob_dashboards WHERE account_id = ?").all(accountId) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}
