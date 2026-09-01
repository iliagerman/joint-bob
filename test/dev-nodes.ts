// Shared harness for tests that run the real server against a seeded dev
// environment. Not named `*.test.ts`, so the test runner does not pick it up.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";

export interface SeededNode {
  key: string;
  name: string;
  port: number;
  url: string;
  dataDir: string;
  cookieName: string;
  nodeId: string;
  projects: Array<{ id: string; name: string; path: string }>;
}

export interface DevEnvironment {
  root: string;
  home: string;
  username: string;
  password: string;
  nodes: SeededNode[];
}

export interface SignedIn {
  cookie: string;
  csrfToken: string;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      if (!address || typeof address === "string") throw new Error("Could not allocate a test port");
      socket.close(() => resolve(address.port));
    });
  });
}

export async function seedDevEnvironment(root: string, nodeCount: 1 | 2): Promise<DevEnvironment> {
  const [portA, portB] = await Promise.all([freePort(), freePort()]);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/dev-seed.ts", "--root", root, "--nodes", String(nodeCount), "--json"], {
      cwd: process.cwd(),
      env: { ...process.env, JOINT_BOB_DEV_PORT_A: String(portA), JOINT_BOB_DEV_PORT_B: String(portB) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => status === 0 ? resolve(JSON.parse(stdout.trim()) as DevEnvironment) : reject(new Error(stderr || `dev-seed exited ${status}`)));
  });
}

export function startDevNode(environment: DevEnvironment, node: SeededNode, extraEnv: Record<string, string> = {}): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(node.port),
        NODE_ENV: "test",
        HOME: environment.home,
        JOINT_BOB_DATA_DIR: node.dataDir,
        // What `scripts/dev-local.sh` sets, so the tests exercise the same
        // configuration a developer's browser talks to.
        JOINT_BOB_SESSION_COOKIE: node.cookieName,
        JOINT_BOB_INSECURE_COOKIE: "1",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => reject(new Error(`Node ${node.key} startup timed out`)), 30_000);
    child.once("exit", (status) => reject(new Error(`Node ${node.key} exited during startup: ${status}`)));
    child.stdout!.on("data", (chunk) => {
      if (!String(chunk).includes("Joint Bob listening")) return;
      clearTimeout(timeout);
      resolve(child);
    });
  });
}

export async function stopDevNode(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill("SIGTERM"); });
}

export async function signIn(environment: DevEnvironment, node: SeededNode): Promise<SignedIn> {
  const response = await fetch(`${node.url}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: environment.username, password: environment.password }),
  });
  if (!response.ok) throw new Error(`Sign in to node ${node.key} failed with ${response.status}`);
  const body = await response.json() as { csrfToken: string };
  const cookie = (response.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ");
  return { cookie, csrfToken: body.csrfToken };
}

export async function api<T>(node: SeededNode, session: SignedIn, method: string, endpoint: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${node.url}/api${endpoint}`, {
    method,
    headers: {
      Cookie: session.cookie,
      "x-csrf-token": session.csrfToken,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() as T };
}

export function projectNamed(node: SeededNode, name: string): SeededNode["projects"][number] {
  const project = node.projects.find((candidate) => candidate.name === name);
  if (!project) throw new Error(`Node ${node.key} has no project named ${name}`);
  return project;
}

export function screenshotPath(root: string, name: string): string {
  return path.join(root, `${name}.png`);
}
