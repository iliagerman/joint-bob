// Seeds one node's SQLite database.
//
// Every module in src/ reads JOINT_BOB_DATA_DIR and HOME when it is first
// imported, and ES modules are cached per process, so one process can only ever
// serve one node. `scripts/dev-seed.ts` therefore spawns this script once per
// node instead of looping in-process.
//
// Reads one JSON job on stdin and writes one JSON result on stdout.
import { mkdir } from "node:fs/promises";
import type { ProjectRecord } from "../src/types.js";

interface SeedJob {
  dataDir: string;
  home: string;
  node: { name: string; url: string };
  admin: { username: string; password: string };
  paths: { piSessions: string; claudeConfig: string; claudeProjects: string; projectsHome: string };
  projects: Array<{ name: string; path: string }>;
  /** A twin's projects, recorded here under the same IDs so twin pairing mirrors them. */
  mirrorProjects?: ProjectRecord[];
}

const job = JSON.parse(await new Promise<string>((resolve, reject) => {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => resolve(input));
  process.stdin.on("error", reject);
})) as SeedJob;

process.env.JOINT_BOB_DATA_DIR = job.dataDir;
process.env.HOME = job.home;
await mkdir(job.dataDir, { recursive: true });

const { updateSettings } = await import("../src/settings.js");
const { authenticationStatus, createAdministrator } = await import("../src/auth.js");
const { addProject, importProject } = await import("../src/store.js");
const { updateClusterNode } = await import("../src/cluster.js");

updateSettings({
  pi: { executable: "", configPath: job.paths.claudeConfig.replace(/\.claude$/, ".pi"), sessionPath: job.paths.piSessions },
  claude: { executable: "", configPath: job.paths.claudeConfig, sessionPath: job.paths.claudeProjects },
  syncthing: { endpoint: "" },
  projects: { homePath: job.paths.projectsHome },
});

if (authenticationStatus().setupRequired) createAdministrator(job.admin.username, job.admin.password, false);

const node = await updateClusterNode(job.node.name, job.node.url);
const projects = [];
if (job.mirrorProjects) for (const project of job.mirrorProjects) projects.push(await importProject(project, project.path));
else for (const demo of job.projects) projects.push(await addProject(demo.name, demo.path));

console.log(JSON.stringify({ nodeId: node.id, projects }));
