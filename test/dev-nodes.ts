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
        // A developer shell may export a real release commit; tests always run as a checkout unless they say otherwise.
        JOINT_BOB_RELEASE: "development",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    waitForDevNode(child, node.key, node.url).then(resolve, reject);
  });
}

export function waitForDevNode(child: ChildProcess, label: string, url?: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let checkingHealth = false;
    const cleanup = (): void => {
      settled = true;
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
      child.stdout!.off("data", onOutput);
    };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onExit = (status: number | null): void => {
      cleanup();
      reject(new Error(`Node ${label} exited during startup: ${status}: ${stderr}`));
    };
    const finish = (): void => {
      if (settled) return;
      cleanup();
      // Keep draining both pipes so a noisy server cannot block on backpressure.
      child.stdout!.resume();
      resolve(child);
    };
    const checkHealth = async (): Promise<void> => {
      while (!settled) {
        try {
          const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) });
          await response.body?.cancel();
          if (response.ok) { finish(); return; }
        } catch { /* Listening is not readiness; initialization may still be running. */ }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    const onOutput = (chunk: Buffer): void => {
      stdout = (stdout + String(chunk)).slice(-1024);
      if (!stdout.includes("Joint Bob listening") || checkingHealth) return;
      checkingHealth = true;
      if (url) void checkHealth();
      else finish();
    };
    const timeout = setTimeout(() => {
      cleanup();
      child.kill("SIGKILL");
      reject(new Error(`Node ${label} startup timed out: ${stderr}`));
    }, 60_000);
    child.stderr!.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-4000); });
    child.once("error", onError);
    child.once("exit", onExit);
    child.stdout!.on("data", onOutput);
  });
}

export async function stopDevNode(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    // The app allows eight seconds to flush native browser profiles on shutdown.
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
    child.kill("SIGTERM");
  });
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
