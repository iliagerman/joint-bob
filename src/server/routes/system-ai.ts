import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { getClusterNode } from '../../cluster.js';
import { systemAiSchema, systemAiSettings } from '../../system-ai-config.js';
import { systemDecisionKey } from '../../system-ai.js';
import { saveSystemAiSetting } from '../../system-ai-replication.js';
import { settingsDatabase } from '../../settings-store.js';
import { backgroundAgentSchema, dashboardAgentSchema, nodeSettings, syncCheckSchema, validateBackgroundAgent, validateDashboardAgent, validateSyncCheck } from '../../settings.js';
import { systemSecretAccounts, systemSecretVariable } from '../../secrets.js';
import { accessibleProviderProfile, listProviderProfiles } from '../../provider-profiles/store.js';
import { adminAccountId } from '../../ownership.js';
import { forgetHarnessReadiness } from '../../background-agent.js';
import { requireAdmin } from '../admin.js';
import { sendError } from '../http-auth.js';
import { app } from '../state.js';

const inputSchema = z.object({ system: systemAiSchema, backgroundAgent: backgroundAgentSchema.optional(), syncCheck: syncCheckSchema.optional(), dashboards: dashboardAgentSchema.optional() }).strict();
async function view() {
  const system = systemAiSettings(), settings = nodeSettings(), node = await getClusterNode();
  let decision = 'System decision credential is available on this machine.';
  try { systemDecisionKey(system.decision.model); }
  catch (error) { decision = (error as Error).message; }
  const owner = adminAccountId();
  return { system, backgroundAgent: settings.backgroundAgent, syncCheck: settings.syncCheck, dashboards: settings.dashboards,
    node: { id: node.id, name: node.name }, secrets: systemSecretAccounts(),
    profiles: owner ? listProviderProfiles(owner).filter(profile => profile.owner === owner).map(({ id, label, provider }) => ({ id, label, provider })) : [],
    readiness: { decision } };
}

app.get('/api/system-ai', requireAdmin, async (_request, response, next) => {
  try { response.json(await view()); } catch (error) { next(error); }
});
app.put('/api/system-ai', requireAdmin, async (request, response, next) => {
  try {
    const input = inputSchema.parse(request.body), previous = systemAiSettings(), settings = nodeSettings();
    // Unchanged replicated choices may be unavailable here; changed local choices must run here.
    for (const operation of ['feedback', 'knowledge'] as const) {
      const choice = input.system.operations[operation];
      if (choice && !isDeepStrictEqual(choice, previous.operations[operation])) validateDashboardAgent(choice);
    }
    if (input.backgroundAgent && !isDeepStrictEqual(input.backgroundAgent, settings.backgroundAgent)) validateBackgroundAgent(input.backgroundAgent);
    if (input.syncCheck && !isDeepStrictEqual(input.syncCheck, settings.syncCheck)) validateSyncCheck(input.syncCheck);
    if (input.dashboards && !isDeepStrictEqual(input.dashboards, settings.dashboards)) validateDashboardAgent(input.dashboards);
    for (const [field, name] of [['typesafeAccountId', 'TYPESAFE_AI_API_KEY'], ['layaAccountId', 'LAYA_API_KEY']] as const) {
      const id = input.system.decision[field];
      // Preserve a saved choice while its twin copy is still arriving; never silently replace it.
      if (id && id !== previous.decision[field]) systemSecretVariable(id, name);
    }
    for (const [provider, id] of Object.entries(input.system.profiles)) {
      if (!id || id === previous.profiles[provider as keyof typeof previous.profiles]) continue;
      const owner = adminAccountId();
      if (!owner) throw new Error('System AI has no local administrator account.');
      const profile = accessibleProviderProfile(owner, id, 'automation');
      if (profile.owner !== owner || profile.provider !== provider) throw new Error('Choose an owned login profile for this system agent.');
    }
    const { id } = await getClusterNode(), db = settingsDatabase();
    db.exec('BEGIN IMMEDIATE');
    try {
      saveSystemAiSetting(db, id, 'systemAI', JSON.stringify(input.system));
      for (const key of ['backgroundAgent', 'syncCheck', 'dashboards'] as const) if (input[key]) saveSystemAiSetting(db, id, key, JSON.stringify(input[key]));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    forgetHarnessReadiness();
    response.json(await view());
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, 'Invalid System AI settings'); return; }
    if (error instanceof Error && /secret|profile|administrator|harness|provider/.test(error.message)) { sendError(response, 400, error.message); return; }
    next(error);
  }
});
