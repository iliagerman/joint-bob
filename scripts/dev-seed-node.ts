// Seeds one node's SQLite database, or pairs it with another node.
//
// Every module in src/ reads JOINT_BOB_DATA_DIR and HOME when it is first
// imported, and ES modules are cached per process, so one process can only ever
// serve one node. `scripts/dev-seed.ts` therefore spawns this script once per
// node instead of looping in-process.
//
// Reads one JSON job on stdin and writes one JSON result on stdout.
import { mkdir } from "node:fs/promises";

interface SeedJob {
  mode: "seed";
  dataDir: string;
  home: string;
  node: { name: string; url: string };
  admin: { username: string; password: string };
  paths: { piSessions: string; claudeConfig: string; claudeProjects: string; projectsHome: string };
  projects: Array<{ name: string; path: string }>;
}

interface PairJob {
  mode: "pair";
  dataDir: string;
  home: string;
  peers: Array<{ id: string; name: string; url: string; token: string }>;
  aliases: Array<{ projectId: string; aliasIds: string[] }>;
}

const job = JSON.parse(await new Promise<string>((resolve, reject) => {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => resolve(input));
  process.stdin.on("error", reject);
})) as SeedJob | PairJob;

process.env.JOINT_BOB_DATA_DIR = job.dataDir;
process.env.HOME = job.home;
await mkdir(job.dataDir, { recursive: true });

if (job.mode === "seed") {
  const { updateSettings } = await import("../src/settings.js");
  const { authenticationStatus, createAdministrator } = await import("../src/auth.js");
  const { addProject } = await import("../src/store.js");
  const { updateClusterNode, getClusterMachineToken } = await import("../src/cluster.js");

  updateSettings({
    pi: { executable: "", configPath: job.paths.claudeConfig.replace(/\.claude$/, ".pi"), sessionPath: job.paths.piSessions },
    claude: { executable: "", configPath: job.paths.claudeConfig, sessionPath: job.paths.claudeProjects },
    syncthing: { endpoint: "" },
    projects: { homePath: job.paths.projectsHome },
  });

  if (authenticationStatus().setupRequired) createAdministrator(job.admin.username, job.admin.password, false);

  const node = await updateClusterNode(job.node.name, job.node.url);
  const projects = [];
  for (const demo of job.projects) projects.push(await addProject(demo.name, demo.path));

  console.log(JSON.stringify({
    nodeId: node.id,
    token: await getClusterMachineToken(),
    projects: projects.map((project) => ({ id: project.id, name: project.name, path: project.path })),
  }));
} else {
  const { saveClusterPeer } = await import("../src/cluster.js");
  const { registerProjectAliases } = await import("../src/store.js");
  const now = new Date().toISOString();
  for (const peer of job.peers) {
    await saveClusterPeer({ id: peer.id, name: peer.name, url: peer.url, token: peer.token, pairedAt: now, lastSeenAt: now, createdAt: now, updatedAt: now });
  }
  for (const alias of job.aliases) await registerProjectAliases(alias.projectId, alias.aliasIds);
  console.log(JSON.stringify({ peers: job.peers.length, aliases: job.aliases.length }));
}
