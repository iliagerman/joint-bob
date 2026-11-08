import { stat } from 'node:fs/promises';
import { listHarnessSessions } from '../harnesses.js';
import { fingerprint, QUALITY_VERSION } from '../quality-analytics.js';
import { qualityModelId } from './quality-claude.js';
import { readSubjects } from '../project-knowledge.js';
import { projectAdditionalPaths } from './session-scope.js';
import { asNode } from '../account-context.js';
import { listConversationRecords } from '../conversation-records.js';
import { isInternalSession } from '../internal-sessions.js';
import { sessionFeedbackOverrides } from '../names.js';
import { withProjectRuntime } from '../project-runtime.js';
import { QualityStore } from '../quality-analytics.js';
import { settingsDatabase } from '../settings-store.js';
import { onSessionListingChange } from '../session-listing-revisions.js';
import { getProject, listProjects } from '../store.js';
import { loadConversationMessages } from './conversation-turns.js';
import { harnessSessions, harnessSessionBusy } from './harness-sessions.js';
import { QualityCollector, QualityCollectionError, QualityEvidenceUnavailable } from './quality-collector.js';
import { analyzeQualityReply } from './quality-models.js';

let store: QualityStore | undefined;
export function qualityStore(): QualityStore { return store ??= new QualityStore(settingsDatabase()); }
let worker: QualityCollector | undefined;
let started = false;
const timers = new Map<string, NodeJS.Timeout>();
export function qualityWorker(): QualityCollector {
  return worker ??= new QualityCollector(qualityStore(), {
    async inventory(projectId) {
      return asNode(async () => {
        const rows: Array<{ projectId: string; conversationId: string; revision: string }> = [];
        const feedback = await sessionFeedbackOverrides();
        for (const project of await listProjects()) {
          if (projectId && projectId !== project.id) continue;
          const records = (await listConversationRecords(project.id)).filter(row => !isInternalSession(row.sessionId));
          const sessions = await listHarnessSessions({ ...project, additionalPaths: await projectAdditionalPaths(project.id) }, [], records.map(row => `${row.engine}:${row.sessionId}`));
          const ids = new Set([...records.map(row => row.conversationId ?? row.sessionId), ...sessions.map(session => session.conversationId ?? session.id)]);
          const evaluationRevision = fingerprint({ version: QUALITY_VERSION, model: qualityModelId(), rules: readSubjects(project.path) });
          for (const conversationId of ids) {
            const session = sessions.find(item => (item.conversationId ?? item.id) === conversationId);
            const files = session?.segments?.length ? session.segments.map(segment => segment.path) : [session?.path ?? ''];
            const signatures = await Promise.all(files.map(async file => {
              if (!file || file.startsWith('draft:')) return null;
              try { const info = await stat(file.replace(/^[a-z][a-z0-9_-]*:/i, '')); return [info.size, info.mtimeMs]; }
              catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
            }));
            rows.push({ projectId: project.id, conversationId, revision: fingerprint({ signatures, feedback: feedback[conversationId], evaluationRevision }) });
          }
        }
        return rows;
      });
    },
    async load(projectId, conversationId) {
      return asNode(() => withProjectRuntime(projectId, async () => {
        const project = await getProject(projectId);
        if (!project) throw new QualityCollectionError('Project is no longer accessible locally.');
        let transcript;
        try { transcript = await loadConversationMessages(project, conversationId); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error instanceof Error && error.message === 'Conversation not found in this project')) throw new QualityEvidenceUnavailable('No local transcript evidence is available. No remote data was requested.');
          throw error;
        }
        const busy = [...harnessSessions.values()].some(shared => shared.projectId === projectId && shared.conversationId === conversationId && harnessSessionBusy(shared));
        const last = transcript.messages.at(-1);
        return { ...transcript, evaluationRevision: fingerprint({ rules: readSubjects(project.path), model: qualityModelId(), version: QUALITY_VERSION }), complete: !busy && last?.role !== 'toolResult' && last?.role !== 'tool' };
      }));
    },
    async feedback(projectId, conversationId) {
      const record = await asNode(async () => (await sessionFeedbackOverrides())[conversationId]);
      return record?.projectId === projectId && record.feedback ? { ...record.feedback, source: record.source } : null;
    },
    analyze: (projectId, _conversationId, reply, signal) => asNode(() => withProjectRuntime(projectId, () => analyzeQualityReply(projectId, reply, qualityStore().types(projectId), signal))),
  });
}
function run(projectId?: string, retry = false): void {
  qualityStore().scanError('');
  void asNode(() => qualityWorker().scan(projectId, retry)).catch(() => {
    // Do not print exceptions from providers: they may contain the supplied evidence.
    qualityStore().scanError('Could not scan local conversations. Check local file access and retry from Settings → Quality.');
    console.warn('Quality aggregation could not scan local conversations; retry from Settings → Quality.');
  });
}
/** One-time startup inventory, then existing local change events, not a sync timer. */
export function startQualityCollection(): void {
  if (started) return;
  started = true;
  qualityStore().recover();
  onSessionListingChange(projectId => {
    if (!qualityStore().enabled()) return;
    const key = projectId ?? '*';
    // Throttle rather than wait for silence: a busy synced project must not starve collection.
    if (timers.has(key)) return;
    const timer = setTimeout(() => { timers.delete(key); run(projectId); }, 10_000);
    timer.unref(); timers.set(key, timer);
  });
  if (qualityStore().enabled()) run(undefined, true);
}
export function setQualityCollection(enabled: boolean): void {
  qualityStore().setEnabled(enabled);
  if (!enabled) {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear(); qualityWorker().stop();
  } else { startQualityCollection(); run(undefined, true); }
}
export function retryQualityCollection(): void { if (qualityStore().enabled()) run(undefined, true); }
