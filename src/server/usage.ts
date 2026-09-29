import { listHarnessSessions } from "../harnesses.js";
import { listProjects } from "../store.js";
import { usageInventoryCoverage } from "../usage-ledger.js";

export interface UsageCoverage { projects: number; sessions: number; missing: number; refreshedAt: string }
let cached: UsageCoverage | undefined;
let inFlight: Promise<UsageCoverage> | undefined;
let last = 0;

async function run(): Promise<UsageCoverage> {
  const projects = await listProjects();
  for (const project of projects) await listHarnessSessions({ ...project, historyDays: 0 });
  return { ...usageInventoryCoverage(projects.map((project) => project.id)), refreshedAt: new Date().toISOString() };
}

export function refreshAllUsage(force = false): Promise<UsageCoverage> {
  if (inFlight) return inFlight;
  if (!force && cached && Date.now() - last < 30_000) return Promise.resolve(cached);
  inFlight = run().then((result) => {
    cached = result;
    last = Date.now();
    return result;
  }).finally(() => { inFlight = undefined; });
  return inFlight;
}
