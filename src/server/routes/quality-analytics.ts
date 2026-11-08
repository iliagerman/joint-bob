import { z } from 'zod';
import { QUALITY_VERSION } from '../../quality-analytics.js';
import { listProjects } from '../../store.js';
import { requireAdmin } from '../admin.js';
import { sendError } from '../http-auth.js';
import { qualityStore, retryQualityCollection, setQualityCollection } from '../quality-service.js';
import { app } from '../state.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value)));
const query = z.object({ page: z.coerce.number().int().min(0).max(100000).default(0), pageSize: z.coerce.number().int().min(1).max(50).default(8), projectId: z.string().max(300).optional(), from: date.optional(), to: date.optional(), model: z.string().max(300).optional(), harness: z.string().max(80).optional(), issue: z.string().max(60).optional(), version: z.string().max(100).default(QUALITY_VERSION), claudeEvaluator: z.string().max(300).optional(), jevEvaluator: z.string().max(300).optional() }).strict();

app.get('/api/quality-analytics', requireAdmin, async (request, response, next) => {
  try {
    const filter = query.parse(request.query);
    const projects = await listProjects(); // Acting account's current visibility, even for aggregates.
    const view = qualityStore().view(projects.map(project => project.id), { ...filter, ...(filter.to ? { to: `${filter.to}T23:59:59.999Z` } : {}) });
    response.json({ enabled: qualityStore().enabled(), projects: projects.map(project => ({ id: project.id, name: project.name })), ...view });
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, 'Invalid quality analytics filter'); return; }
    next(error);
  }
});
app.put('/api/quality-analytics/settings', requireAdmin, (request, response, next) => {
  try {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(request.body);
    setQualityCollection(enabled); response.json({ enabled: qualityStore().enabled() });
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, 'enabled must be a boolean'); return; }
    next(error);
  }
});
app.post('/api/quality-analytics/retry', requireAdmin, (_request, response) => {
  if (!qualityStore().enabled()) { sendError(response, 409, 'Enable aggregation on this machine before retrying.'); return; }
  retryQualityCollection(); response.status(202).json({ queued: true });
});
