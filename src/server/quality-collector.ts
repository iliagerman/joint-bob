import type { ChatMessage } from '../types.js';
import { fingerprint, QUALITY_VERSION, replyWindows, type QualityReply, type QualityResult, QualityStore } from '../quality-analytics.js';

export class QualityCollectionError extends Error {}
export class QualityEvidenceUnavailable extends QualityCollectionError {}
export class QualityReplyError extends QualityCollectionError {}
export interface QualityRuntime {
  inventory(projectId?: string): Promise<Array<{ projectId: string; conversationId: string; revision?: string }>>;
  load(projectId: string, conversationId: string): Promise<{ messages: ChatMessage[]; lastHarness: string; complete: boolean; evaluationRevision?: string }>;
  analyze(projectId: string, conversationId: string, reply: QualityReply, signal: AbortSignal): Promise<QualityResult>;
  feedback(projectId: string, conversationId: string): Promise<{ rating: string; source: string; description: string } | null>;
}
/** One serial worker per collecting machine. Queue rows contain identifiers only. */
export class QualityCollector {
  private active?: Promise<void>;
  private abort?: AbortController;
  private scans = new Set<string>();
  private retryRequested = false;
  constructor(readonly store: QualityStore, readonly runtime: QualityRuntime) {}
  stop(): void { this.abort?.abort(); this.scans.clear(); this.retryRequested = false; }
  scan(projectId?: string, retry = false): Promise<void> {
    if (!this.store.enabled()) return Promise.resolve();
    this.scans.add(projectId ?? '*');
    this.retryRequested ||= retry;
    if (this.active) return this.active;
    this.active = this.run().finally(() => { this.active = undefined; });
    return this.active;
  }
  private async run(): Promise<void> {
    while (this.store.enabled() && (this.scans.size || this.store.next())) {
      if (this.scans.size) {
        const projects = [...this.scans]; this.scans.clear();
        const retry = this.retryRequested; this.retryRequested = false;
        for (const project of projects) {
          for (const row of await this.runtime.inventory(project === '*' ? undefined : project)) {
            if (!this.store.enabled()) return;
            this.store.enqueue(row.projectId, row.conversationId, retry, row.revision);
          }
        }
      }
      const job = this.store.next();
      if (job) await this.process(job.projectId, job.conversationId);
    }
  }
  private async process(projectId: string, conversationId: string): Promise<void> {
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.store.jobState(projectId, conversationId, 'running');
    try {
      const feedback = await this.runtime.feedback(projectId, conversationId);
      if (!this.store.enabled() || signal.aborted) return;
      if (feedback) this.store.feedback(projectId, conversationId, feedback.rating, feedback.source);
      else this.store.clearFeedback(projectId, conversationId);
      const transcript = await this.runtime.load(projectId, conversationId);
      if (signal.aborted || !this.store.enabled()) return;
      if (!transcript.messages.length) { this.store.jobState(projectId, conversationId, 'unavailable', 'No local transcript evidence'); return; }
      if (!transcript.complete) { this.store.jobState(projectId, conversationId, 'waiting', 'Waiting for a completed local turn'); return; }
      let failedReplies = 0;
      const replies = replyWindows(transcript.messages, transcript.lastHarness);
      this.store.coverage(projectId, conversationId, replies.length);
      for (const reply of replies) {
        reply.conversationFeedback = feedback;
        if (!this.store.enabled() || signal.aborted) return;
        const hash = fingerprint({ reply, feedback, evaluationRevision: transcript.evaluationRevision, version: QUALITY_VERSION });
        if (this.store.has(projectId, conversationId, reply.id, hash)) continue;
        let result: QualityResult;
        try { result = await this.runtime.analyze(projectId, conversationId, reply, signal); }
        catch (error) {
          if (!(error instanceof QualityReplyError)) throw error;
          failedReplies++;
          continue;
        }
        if (!this.store.enabled() || signal.aborted) return;
        const latest = await this.runtime.load(projectId, conversationId);
        const latestReply = replyWindows(latest.messages, latest.lastHarness).find(candidate => candidate.id === reply.id);
        const latestFeedback = await this.runtime.feedback(projectId, conversationId);
        if (!latest.complete || latest.evaluationRevision !== transcript.evaluationRevision || !latestReply || fingerprint({ ...latestReply, conversationFeedback: latestFeedback }) !== fingerprint(reply)) {
          this.store.jobState(projectId, conversationId, 'waiting', 'Evidence changed during analysis.');
          this.scans.add(projectId);
          return;
        }
        if (!this.store.enabled() || signal.aborted) return;
        this.store.put({ projectId, conversationId, replyId: reply.id, at: reply.at, harness: reply.harness, model: reply.model, fingerprint: hash, result });
      }
      this.store.jobState(projectId, conversationId, failedReplies ? 'error' : replies.length ? 'complete' : 'empty', failedReplies ? `${failedReplies} replies could not be evaluated; later replies were still processed. Retry from Settings → Quality.` : '');
    } catch (error) {
      if (!signal.aborted && this.store.enabled()) this.store.jobState(projectId, conversationId, error instanceof QualityEvidenceUnavailable ? 'unavailable' : 'error', error instanceof QualityCollectionError ? error.message : 'Analysis failed; check local model configuration and retry. Source content was not logged.');
    } finally {
      if (signal.aborted || !this.store.enabled()) this.store.jobState(projectId, conversationId, 'pending');
      this.abort = undefined;
    }
  }
}
