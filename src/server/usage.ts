import { listHarnessSessions } from "../harnesses.js";
import { listProjects } from "../store.js";
import { usageIngestIdle } from "../usage-ingest.js";
import { usageInventoryCoverage } from "../usage-ledger.js";

export interface UsageCoverage { projects: number; sessions: number; missing: number; refreshedAt: string }
export interface UsageRefreshStatus { refreshing: boolean; refreshedAt: string | null; error: string | null }

export function createUsageRefreshController(work: () => Promise<UsageCoverage>, ttlMs = 30_000) {
  let cached: UsageCoverage | undefined;
  let inFlight: Promise<UsageCoverage> | undefined;
  let pending = false;
  let last = 0;
  let lastError: string | null = null;

  const refresh = (force = false): Promise<UsageCoverage> => {
    if (inFlight) return inFlight;
    if (!force && cached && Date.now() - last < ttlMs) return Promise.resolve(cached);
    // A retry starts here, rather than when it succeeds.
    lastError = null;
    inFlight = work().then((result) => {
      cached = result;
      last = Date.now();
      return result;
    }).catch((error: unknown) => {
      lastError = error instanceof Error ? "Usage refresh failed" : "Usage refresh unavailable";
      throw error;
    }).finally(() => { inFlight = undefined; });
    return inFlight;
  };

  const request = (force = false): void => {
    if (pending || inFlight || (!force && cached && Date.now() - last < ttlMs)) return;
    pending = true;
    lastError = null;
    setImmediate(() => {
      pending = false;
      void refresh(force).catch(() => { /* sanitized status is the public result */ });
    });
  };

  const status = (): UsageRefreshStatus => ({
    refreshing: pending || Boolean(inFlight),
    refreshedAt: cached?.refreshedAt ?? null,
    error: lastError,
  });
  return { request, refresh, status };
}

async function run(): Promise<UsageCoverage> {
  const projects = await listProjects();
  for (const project of projects) await listHarnessSessions({ ...project, historyDays: 0 });
  await usageIngestIdle();
  return { ...usageInventoryCoverage(projects.map((project) => project.id)), refreshedAt: new Date().toISOString() };
}

const controller = createUsageRefreshController(run);
export const refreshAllUsage = (force = false): Promise<UsageCoverage> => controller.refresh(force);
export const requestUsageRefresh = (force = false): void => controller.request(force);
export const usageRefreshStatus = (): UsageRefreshStatus => controller.status();
