import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startSupervisor } from "../scripts/joint-bob-supervisor.mjs";
import { supervisorRequest } from "../scripts/supervisor-client.mjs";
import { seedDevEnvironment, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "./dev-nodes.js";

interface Runtime {
  close(): Promise<void>;
}

export interface BackgroundFixture {
  root: string;
  environment: DevEnvironment;
  node: SeededNode;
  server: ChildProcess;
  runtime: Runtime;
}

export interface BackgroundClusterFixture {
  root: string;
  environment: DevEnvironment;
  nodes: [SeededNode, SeededNode];
  servers: [ChildProcess, ChildProcess];
  runtimes: [Runtime, Runtime];
}

async function supervisor(root: string, node: SeededNode): Promise<Runtime> {
  return await startSupervisor({
    dataDirectory: node.dataDir,
    app: {
      executable: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
    },
  }) as Runtime;
}

export async function backgroundFixture(extraEnv: (root: string) => Record<string, string> = () => ({})): Promise<BackgroundFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-background-"));
  let server: ChildProcess | undefined;
  let runtime: Runtime | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    runtime = await supervisor(root, node);
    server = await startDevNode(environment, node, extraEnv(root));
    return { root, environment, node, server, runtime };
  } catch (error) {
    if (server) await stopDevNode(server);
    if (runtime) await runtime.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function backgroundClusterFixture(extraEnv: (root: string) => Record<string, string> = () => ({})): Promise<BackgroundClusterFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-bg-"));
  const servers: ChildProcess[] = [];
  const runtimes: Runtime[] = [];
  try {
    const environment = await seedDevEnvironment(root, 2);
    const nodes = environment.nodes as [SeededNode, SeededNode];
    for (const node of nodes) runtimes.push(await supervisor(root, node));
    const env = extraEnv(root);
    for (const node of nodes) servers.push(await startDevNode(environment, node, env));
    return {
      root,
      environment,
      nodes,
      servers: servers as [ChildProcess, ChildProcess],
      runtimes: runtimes as [Runtime, Runtime],
    };
  } catch (error) {
    await Promise.all(servers.map((server) => stopDevNode(server)));
    await Promise.all(runtimes.map((runtime) => runtime.close()));
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function closeBackgroundFixture(f: BackgroundFixture): Promise<void> {
  await stopDevNode(f.server);
  await f.runtime.close();
  await rm(f.root, { recursive: true, force: true });
}

export async function closeBackgroundClusterFixture(f: BackgroundClusterFixture): Promise<void> {
  await Promise.all(f.servers.map((server) => stopDevNode(server)));
  await Promise.all(f.runtimes.map((runtime) => runtime.close()));
  await rm(f.root, { recursive: true, force: true });
}

export async function startSyntheticTask(
  f: Pick<BackgroundFixture, "node" | "root">,
  projectId: string,
  conversationId: string,
  id: string,
  held = false,
): Promise<void> {
  await supervisorRequest(f.node.dataDir, {
    action: "start",
    id,
    identity: JSON.stringify([projectId, conversationId]),
    name: "safe-task",
    executable: process.execPath,
    args: ["-e", held ? "console.log('safe-output');setInterval(()=>{},1000)" : "console.log('safe-output')"],
    cwd: f.root,
    env: {},
  });
}
