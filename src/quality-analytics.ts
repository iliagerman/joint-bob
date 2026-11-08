import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ChatMessage } from './types.js';

export const QUALITY_VERSION = '1';
export interface QualityIssue { type: string; reason: string; lesson: string; ruleId: string; adoptedAt: string }
export interface QualityResult {
  outcome: 'good' | 'issue' | 'unknown'; reason: string; issues: QualityIssue[];
  confidence: number; probabilities: Record<string, number>; claudeModel: string; jevModel: string; version: string;
  usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } | null;
  judgments?: Record<string, { choice: string; confidence: number; probabilities: Record<string, number> }>;
  windows?: Array<Pick<QualityResult, 'outcome' | 'confidence' | 'probabilities' | 'claudeModel' | 'jevModel' | 'usage' | 'judgments'>>;
}
export interface QualityObservation {
  projectId: string; conversationId: string; replyId: string; at: string; harness: string; model: string;
  fingerprint: string; result: QualityResult;
}
export interface QualityFilter { page: number; pageSize: number; projectId?: string; from?: string; to?: string; model?: string; issue?: string; version?: string; harness?: string; claudeEvaluator?: string; jevEvaluator?: string }
export interface QualityChunk { request: string; assistant: string; feedback: string }
export interface QualityReply { id: string; at: string; harness: string; model: string; chunks: QualityChunk[]; conversationFeedback?: { rating: string; source: string; description: string } | null }
export const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Source text exists only in these transient windows, never in the analytics store. */
export function replyWindows(messages: ChatMessage[], harness: string): QualityReply[] {
  const replies: QualityReply[] = [];
  let request = '';
  for (const [index, message] of messages.entries()) {
    if (message.role === 'user') { request = message.text; continue; }
    if (message.role !== 'assistant' || !message.text.trim()) continue;
    const nextUser = messages.slice(index + 1).find(candidate => candidate.role === 'user');
    const chunks: QualityChunk[] = [];
    const parts = (text: string) => text.match(/[\s\S]{1,8000}/g) ?? [''];
    const requests = parts(request), answers = parts(message.text), feedback = parts(nextUser?.text ?? '');
    for (let n = 0; n < Math.max(requests.length, answers.length, feedback.length); n++) {
      chunks.push({ request: requests[n] ?? requests[0], assistant: answers[n] ?? '', feedback: feedback[n] ?? '' });
    }
    replies.push({ id: message.id || String(index), at: message.timestamp ?? '', harness: message.attribution?.harnessId ?? harness,
      model: message.attribution?.modelId ?? '', chunks });
  }
  return replies;
}

/** These tables deliberately have no replication events or transcript columns. */
export class QualityStore {
  constructor(readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS quality_config(singleton INTEGER PRIMARY KEY CHECK(singleton=1),enabled INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS quality_health(singleton INTEGER PRIMARY KEY CHECK(singleton=1),error TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quality_coverage(project_id TEXT NOT NULL,conversation_id TEXT NOT NULL,reply_count INTEGER NOT NULL,PRIMARY KEY(project_id,conversation_id));
      CREATE TABLE IF NOT EXISTS quality_sources(project_id TEXT NOT NULL,conversation_id TEXT NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(project_id,conversation_id));
      CREATE TABLE IF NOT EXISTS quality_jobs(project_id TEXT NOT NULL,conversation_id TEXT NOT NULL,state TEXT NOT NULL,error TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL,PRIMARY KEY(project_id,conversation_id));
      CREATE TABLE IF NOT EXISTS quality_observations(project_id TEXT NOT NULL,conversation_id TEXT NOT NULL,reply_id TEXT NOT NULL,at TEXT NOT NULL,harness TEXT NOT NULL,model TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,evaluated_at TEXT NOT NULL,PRIMARY KEY(project_id,conversation_id,reply_id));
      CREATE TABLE IF NOT EXISTS quality_feedback(project_id TEXT NOT NULL,conversation_id TEXT NOT NULL,rating TEXT NOT NULL,source TEXT NOT NULL,PRIMARY KEY(project_id,conversation_id));
      CREATE INDEX IF NOT EXISTS quality_observations_date ON quality_observations(project_id,at);`);
  }
  enabled(): boolean { return this.db.prepare('SELECT enabled FROM quality_config WHERE singleton=1').get()?.enabled === 1; }
  setEnabled(enabled: boolean): void { this.db.prepare('INSERT INTO quality_config VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET enabled=excluded.enabled').run(Number(enabled)); }
  scanError(message: string): void { this.db.prepare('INSERT INTO quality_health VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET error=excluded.error').run(message); }
  recover(): void { this.db.prepare("UPDATE quality_jobs SET state='pending' WHERE state='running'").run(); }
  enqueue(projectId: string, conversationId: string, retry = false, revision?: string): void {
    if (revision) {
      const previous = this.db.prepare('SELECT revision FROM quality_sources WHERE project_id=? AND conversation_id=?').get(projectId, conversationId)?.revision;
      const state = this.db.prepare('SELECT state FROM quality_jobs WHERE project_id=? AND conversation_id=?').get(projectId, conversationId)?.state;
      if (!retry && previous === revision && ['complete', 'empty', 'error', 'unavailable'].includes(String(state))) return;
      retry ||= previous !== revision;
      this.db.prepare('INSERT INTO quality_sources VALUES(?,?,?) ON CONFLICT(project_id,conversation_id) DO UPDATE SET revision=excluded.revision').run(projectId, conversationId, revision);
    }
    this.db.prepare(`INSERT INTO quality_jobs VALUES(?,?,'pending','',?) ON CONFLICT(project_id,conversation_id) DO UPDATE SET state='pending',error='',updated_at=excluded.updated_at WHERE quality_jobs.state IN ('complete','unavailable','empty','waiting') ${retry ? "OR quality_jobs.state='error'" : ''}`).run(projectId, conversationId, new Date().toISOString());
  }
  next(): { projectId: string; conversationId: string } | undefined {
    const row = this.db.prepare("SELECT project_id AS projectId,conversation_id AS conversationId FROM quality_jobs WHERE state='pending' ORDER BY updated_at LIMIT 1").get() as ReturnType<QualityStore['next']>;
    return row ? { ...row } : undefined;
  }
  jobState(projectId: string, conversationId: string, state: string, error = ''): void {
    this.db.prepare('INSERT INTO quality_jobs VALUES(?,?,?,?,?) ON CONFLICT(project_id,conversation_id) DO UPDATE SET state=excluded.state,error=excluded.error,updated_at=excluded.updated_at').run(projectId, conversationId, state, error, new Date().toISOString());
  }
  has(projectId: string, conversationId: string, replyId: string, hash: string): boolean {
    return this.db.prepare('SELECT fingerprint FROM quality_observations WHERE project_id=? AND conversation_id=? AND reply_id=?').get(projectId, conversationId, replyId)?.fingerprint === hash;
  }
  put(sample: QualityObservation): void {
    this.db.prepare(`INSERT INTO quality_observations VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,conversation_id,reply_id) DO UPDATE SET at=excluded.at,harness=excluded.harness,model=excluded.model,fingerprint=excluded.fingerprint,result=excluded.result,evaluated_at=excluded.evaluated_at`).run(sample.projectId, sample.conversationId, sample.replyId, sample.at, sample.harness, sample.model, sample.fingerprint, JSON.stringify(sample.result), new Date().toISOString());
  }
  feedback(projectId: string, conversationId: string, rating: string, source: string): void {
    this.db.prepare('INSERT INTO quality_feedback VALUES(?,?,?,?) ON CONFLICT(project_id,conversation_id) DO UPDATE SET rating=excluded.rating,source=excluded.source').run(projectId, conversationId, rating, source);
  }
  coverage(projectId: string, conversationId: string, replies: number): void {
    this.db.prepare('INSERT INTO quality_coverage VALUES(?,?,?) ON CONFLICT(project_id,conversation_id) DO UPDATE SET reply_count=excluded.reply_count').run(projectId, conversationId, replies);
  }
  clearFeedback(projectId: string, conversationId: string): void {
    this.db.prepare('DELETE FROM quality_feedback WHERE project_id=? AND conversation_id=?').run(projectId, conversationId);
  }
  types(projectId: string): string[] {
    return (this.db.prepare("SELECT DISTINCT j.value ->> '$.type' AS type FROM quality_observations o,json_each(o.result,'$.issues') j WHERE project_id=? ORDER BY type LIMIT 200").all(projectId) as { type: string }[]).map(row => row.type);
  }
  view(projectIds: string[], filter: QualityFilter) {
    const allowed = filter.projectId ? projectIds.filter(id => id === filter.projectId) : projectIds;
    const marks = allowed.map(() => '?').join(',') || 'NULL';
    const where = [`project_id IN (${marks})`];
    const args = [...allowed];
    for (const [condition, value] of [["at>=?", filter.from], ["at<=?", filter.to], ['model=?', filter.model], ['harness=?', filter.harness], ["json_extract(result,'$.claudeModel')=?", filter.claudeEvaluator], ["json_extract(result,'$.jevModel')=?", filter.jevEvaluator], ["json_extract(result,'$.version')=?", filter.version], ["EXISTS(SELECT 1 FROM json_each(result,'$.issues') WHERE json_extract(value,'$.type')=?)", filter.issue]]) {
      if (value) { where.push(condition!); args.push(value); }
    }
    const clause = where.join(' AND ');
    const totals = this.db.prepare(`SELECT COUNT(*) replies,COALESCE(SUM(json_extract(result,'$.outcome')='issue'),0) issues,COALESCE(SUM(json_extract(result,'$.outcome')='good'),0) good,COALESCE(SUM(json_extract(result,'$.outcome')='unknown'),0) unknown FROM quality_observations WHERE ${clause}`).get(...args) as { replies: number; issues: number; good: number; unknown: number };
    const trends = this.db.prepare(`SELECT CASE WHEN at='' THEN 'undated' ELSE substr(at,1,10) END day,json_extract(result,'$.claudeModel') claudeEvaluator,json_extract(result,'$.jevModel') jevEvaluator,COUNT(*) replies,SUM(json_extract(result,'$.outcome')='issue') issues,SUM(json_extract(result,'$.outcome')='unknown') unknown FROM quality_observations WHERE ${clause} GROUP BY 1,2,3 ORDER BY 1 DESC LIMIT 366`).all(...args);
    const issues = this.db.prepare(`SELECT json_extract(j.value,'$.type') type,COUNT(DISTINCT o.project_id||':'||o.conversation_id||':'||o.reply_id) replies,MIN(NULLIF(o.at,'')) firstSeen,MAX(NULLIF(o.at,'')) lastSeen FROM (SELECT * FROM quality_observations WHERE ${clause}) o,json_each(o.result,'$.issues') j GROUP BY 1 ORDER BY replies DESC,type LIMIT 200`).all(...args);
    const rows = (this.db.prepare(`SELECT project_id projectId,conversation_id conversationId,reply_id replyId,at,harness,model,result,evaluated_at evaluatedAt FROM quality_observations WHERE ${clause} ORDER BY at DESC,project_id,conversation_id,reply_id LIMIT ? OFFSET ?`).all(...args, filter.pageSize, filter.page * filter.pageSize) as Array<Record<string, unknown> & { result: string }>).map(row => ({ ...row, result: JSON.parse(row.result) as QualityResult }));
    const jobs = this.db.prepare(`SELECT state,COUNT(*) count FROM quality_jobs WHERE project_id IN (${marks}) GROUP BY state`).all(...allowed);
    const failures = this.db.prepare(`SELECT project_id projectId,conversation_id conversationId,state,error FROM quality_jobs WHERE project_id IN (${marks}) AND state IN ('error','unavailable') ORDER BY updated_at DESC LIMIT 20`).all(...allowed);
    const feedback = this.db.prepare(`SELECT source,rating,COUNT(*) count FROM quality_feedback WHERE project_id IN (${marks}) GROUP BY source,rating`).all(...allowed);
    const cohortWhere = [`project_id IN (${marks})`];
    const cohortArgs = [...allowed];
    for (const [condition, value] of [["at>=?", filter.from], ["at<=?", filter.to], ['model=?', filter.model], ['harness=?', filter.harness], ["json_extract(result,'$.claudeModel')=?", filter.claudeEvaluator], ["json_extract(result,'$.jevModel')=?", filter.jevEvaluator], ["json_extract(result,'$.version')=?", filter.version]]) {
      if (value) { cohortWhere.push(condition!); cohortArgs.push(value); }
    }
    const lessons = this.db.prepare(`WITH cohort AS (SELECT * FROM quality_observations WHERE ${cohortWhere.join(' AND ')}), rules AS (
      SELECT o.project_id projectId,json_extract(j.value,'$.type') type,json_extract(j.value,'$.ruleId') ruleId,MIN(json_extract(j.value,'$.adoptedAt')) adoptedAt
      FROM cohort o,json_each(o.result,'$.issues') j WHERE json_extract(j.value,'$.ruleId')<>'' AND json_extract(j.value,'$.adoptedAt')<>''
      GROUP BY 1,2,3)
      SELECT r.*,SUM(c.at<>'' AND substr(c.at,1,10)<r.adoptedAt) beforeReplies,SUM(c.at<>'' AND substr(c.at,1,10)>=r.adoptedAt) afterReplies,
      SUM(c.at<>'' AND substr(c.at,1,10)<r.adoptedAt AND EXISTS(SELECT 1 FROM json_each(c.result,'$.issues') j WHERE json_extract(j.value,'$.type')=r.type)) beforeIssues,
      SUM(c.at<>'' AND substr(c.at,1,10)>=r.adoptedAt AND EXISTS(SELECT 1 FROM json_each(c.result,'$.issues') j WHERE json_extract(j.value,'$.type')=r.type)) afterIssues
      FROM rules r JOIN cohort c ON c.project_id=r.projectId WHERE (?='' OR r.type=?) GROUP BY r.projectId,r.type,r.ruleId ORDER BY r.adoptedAt DESC LIMIT 100`).all(...cohortArgs, filter.issue ?? '', filter.issue ?? '');
    const coverage = this.db.prepare(`SELECT COALESCE(SUM(reply_count),0) eligibleReplies FROM quality_coverage WHERE project_id IN (${marks})`).get(...allowed);
    const versions = this.db.prepare(`SELECT DISTINCT json_extract(result,'$.version') version,json_extract(result,'$.claudeModel') claudeModel,json_extract(result,'$.jevModel') jevModel FROM quality_observations WHERE project_id IN (${marks})`).all(...allowed);
    return { collectionError: String(this.db.prepare('SELECT error FROM quality_health WHERE singleton=1').get()?.error ?? ''), totals, coverage, trends, issues, lessons, rows, total: totals.replies, jobs, failures, feedback, versions, page: filter.page, pageSize: filter.pageSize };
  }
}
