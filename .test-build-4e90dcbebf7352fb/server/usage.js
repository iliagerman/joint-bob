import { listHarnessSessions } from "../harnesses.js";
import { listProjects } from "../store.js";
import { usageIngestIdle } from "../usage-ingest.js";
import { usageInventoryCoverage } from "../usage-ledger.js";
function createUsageRefreshController(work, ttlMs = 3e4) {
  let cached;
  let inFlight;
  let pending = false;
  let last = 0;
  let lastError = null;
  const refresh = (force = false) => {
    if (inFlight) return inFlight;
    if (!force && cached && Date.now() - last < ttlMs) return Promise.resolve(cached);
    lastError = null;
    inFlight = work().then((result) => {
      cached = result;
      last = Date.now();
      return result;
    }).catch((error) => {
      lastError = error instanceof Error ? "Usage refresh failed" : "Usage refresh unavailable";
      throw error;
    }).finally(() => {
      inFlight = void 0;
    });
    return inFlight;
  };
  const request = (force = false) => {
    if (pending || inFlight || !force && cached && Date.now() - last < ttlMs) return;
    pending = true;
    lastError = null;
    setImmediate(() => {
      pending = false;
      void refresh(force).catch(() => {
      });
    });
  };
  const status = () => ({
    refreshing: pending || Boolean(inFlight),
    refreshedAt: cached?.refreshedAt ?? null,
    error: lastError
  });
  return { request, refresh, status };
}
async function run() {
  const projects = await listProjects();
  for (const project of projects) await listHarnessSessions({ ...project, historyDays: 0 });
  await usageIngestIdle();
  return { ...usageInventoryCoverage(projects.map((project) => project.id)), refreshedAt: (/* @__PURE__ */ new Date()).toISOString() };
}
const controller = createUsageRefreshController(run);
const refreshAllUsage = (force = false) => controller.refresh(force);
const requestUsageRefresh = (force = false) => controller.request(force);
const usageRefreshStatus = () => controller.status();
export {
  createUsageRefreshController,
  refreshAllUsage,
  requestUsageRefresh,
  usageRefreshStatus
};
