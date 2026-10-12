import { randomUUID } from 'node:crypto';

export interface Candidate { projectId: string; conversationId: string; title: string; costUsd: number | null; durationMs: number | null }
export interface FlowSuggestion {
  id: string; kind: 'skill' | 'script' | 'improvement'; label: string; confidence: number; associatedCostUsd: number;
  evidence: Array<{ projectId: string; conversationId: string; href: string; costUsd: number | null; durationMs: number | null }>;
  estimatedSavings: null;
}
/** Only local metadata; titles are grouping keys, never copied into generated instructions,
 * logged, or sent to another model/service. No script or skill is generated or installed. */
const evidence = (row: Candidate) => ({ projectId: row.projectId, conversationId: row.conversationId, costUsd: row.costUsd, durationMs: row.durationMs,
  href: `/api/usage?${new URLSearchParams({ projectId: row.projectId, conversationId: row.conversationId, refresh: 'false' })}` });
export function suggestRepeatableFlows(candidates: Candidate[]): FlowSuggestion[] {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates.slice(0, 100)) {
    const key = candidate.title.toLowerCase().replace(/\b\d{1,4}(?:[-/:]\d{1,4})*\b/g, '#').replace(/\s+/g, ' ').trim();
    if (key.length < 8) continue;
    const rows = groups.get(key) ?? [];
    rows.push(candidate); groups.set(key, rows);
  }
  return [...groups].filter(([, rows]) => rows.length >= 3).slice(0, 10).map(([key, rows], index) => ({
    id: randomUUID(),
    kind: /^(run|build|deploy|check|update|test)\b/.test(key) ? 'script' as const : 'skill' as const,
    label: `Repeated flow ${index + 1} (${rows.length} conversations)`,
    confidence: Math.min(.7, .25 + rows.length * .05),
    associatedCostUsd: rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0),
    estimatedSavings: null,
    evidence: rows.slice(0, 10).map(evidence),
  }));
}

/** Observed errors on the same read identity in multiple conversations justify review,
 * not a claim that the skill caused those errors or that an edit would save money. */
export function suggestSkillImprovements(rows: Array<{ skillId: string; projectId: string; conversationId: string; costUsd: number | null; durationMs: number | null; toolErrors: number }>): FlowSuggestion[] {
  const groups = new Map<string, typeof rows>();
  for (const row of rows.slice(0, 5000)) {
    const group = groups.get(row.skillId) ?? [];
    group.push(row); groups.set(row.skillId, group);
  }
  return [...groups].filter(([, group]) => new Set(group.map((row) => row.conversationId)).size >= 2 && group.some((row) => row.toolErrors > 0))
    .slice(0, 10).map(([, group], index) => {
      const unique = [...new Map(group.map((row) => [row.conversationId, row])).values()];
      return { id: randomUUID(), kind: 'improvement' as const, label: `Skill review ${index + 1} (${unique.length} conversations with observed use)`,
        confidence: Math.min(.6, .25 + unique.length * .05), associatedCostUsd: group.reduce((sum, row) => sum + (row.costUsd ?? 0), 0),
        estimatedSavings: null, evidence: unique.slice(0, 10).map((row) => evidence({ ...row, title: '' })) };
    });
}
