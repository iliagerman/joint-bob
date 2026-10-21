import { calendarBounds } from "./usage-calendar.js";
import { usageDatabase } from "./usage-ledger.js";

export interface AnalysisScope {
  projectId: string;
  from?: string;
  to?: string;
  timeZone: string;
  limit: number;
}

/** Preview and execution use the same bounded, most-recent selection, never the dashboard scope. */
export function selectAnalysisConversations(scope: AnalysisScope) {
  const db = usageDatabase();
  const bounds = calendarBounds(scope.from, scope.to, scope.timeZone);
  const clauses = ["project_id = ?"], parameters: Array<string | number> = [scope.projectId];
  if (bounds.from) { clauses.push("occurred_at >= ?"); parameters.push(bounds.from); }
  if (bounds.to) { clauses.push("occurred_at < ?"); parameters.push(bounds.to); }
  const activityWhere = clauses.join(" AND ");
  const rows = db.prepare(`WITH activity AS (
      SELECT conversation_id, occurred_at FROM model_usage_events WHERE ${activityWhere}
      UNION ALL SELECT conversation_id, occurred_at FROM usage_difficulty WHERE ${activityWhere}
    ), recent AS (SELECT conversation_id, MAX(occurred_at) last_used FROM activity GROUP BY conversation_id)
    SELECT i.conversation_id conversationId, MAX(i.title) title, COUNT(*) OVER() total
    FROM usage_inventory i LEFT JOIN recent r ON r.conversation_id = i.conversation_id
    WHERE i.project_id = ? ${bounds.from || bounds.to ? "AND r.last_used IS NOT NULL" : ""}
    GROUP BY i.conversation_id ORDER BY MAX(r.last_used) DESC, i.conversation_id LIMIT ?`)
    .all(...parameters, ...parameters, scope.projectId, scope.limit) as unknown as Array<{ conversationId: string; title: string; total: number }>;
  const totalConversations = rows[0]?.total ?? 0;
  const ids = rows.map((row) => row.conversationId);
  // Every downstream event and timing query is restricted to exactly these conversations and dates.
  const selectedWhere = `${activityWhere} AND conversation_id IN (${ids.length ? ids.map(() => "?").join(",") : "NULL"})`;
  return { rows, bounds, totalConversations, truncated: totalConversations > rows.length,
    selectedWhere, selectedParameters: [...parameters, ...ids] };
}
