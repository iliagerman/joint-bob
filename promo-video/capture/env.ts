// Starts and stops the promo video's throwaway nodes. Run from the repository root.
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface PromoNode { key: "a" | "b" | "c"; name: string; username: string; home: string; port: number; url: string; dataDir: string; cookieName: string; nodeId: string; projects: Array<{ id: string; name: string; path: string }> }
export interface PromoEnvironment { root: string; password: string; nodes: PromoNode[] }
export interface Session { cookie: string; csrfToken: string }

export function seed(root: string, extra: string[] = []): Promise<PromoEnvironment> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "promo-video/capture/seed.ts", "--root", root, ...extra], { cwd: repositoryRoot, env: cleanEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => status === 0 ? resolve(JSON.parse(stdout.trim().split("\n").pop()!)) : reject(new Error(stderr || `seed exited ${status}`)));
  });
}

export async function loadEnvironment(root: string): Promise<PromoEnvironment> {
  return JSON.parse(await readFile(path.join(root, "environment.json"), "utf8"));
}

// The shell that runs the capture may carry real tokens. The nodes get none of them.
function cleanEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep = ["PATH", "LANG", "LC_ALL", "TMPDIR", "SHELL", "USER", "LOGNAME", "PLAYWRIGHT_BROWSERS_PATH"];
  return { ...Object.fromEntries(keep.filter((name) => process.env[name]).map((name) => [name, process.env[name]!])), ...extra };
}

export async function startNode(node: PromoNode, log: (line: string) => void = () => {}, extra: Record<string, string> = {}): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: repositoryRoot,
    env: cleanEnvironment({
      HOME: node.home,
      PORT: String(node.port),
      JOINT_BOB_DATA_DIR: node.dataDir,
      JOINT_BOB_BIND_HOST: "127.0.0.1",
      JOINT_BOB_SESSION_COOKIE: node.cookieName,
      JOINT_BOB_INSECURE_COOKIE: "1",
      JOINT_BOB_RELEASE: "development",
      JB_PROMO_SPEED: process.env.JB_PROMO_SPEED ?? "1",
      ...extra,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (chunk) => log(`[${node.key}] ${String(chunk).trimEnd()}`));
  child.stderr!.on("data", (chunk) => log(`[${node.key}!] ${String(chunk).trimEnd()}`));
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Node ${node.key} exited during startup`);
    try {
      const response = await fetch(`${node.url}/api/health`, { signal: AbortSignal.timeout(1_000) });
      await response.body?.cancel();
      if (response.ok) return child;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) { child.kill("SIGKILL"); throw new Error(`Node ${node.key} did not start`); }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export async function stopNode(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
    child.kill("SIGTERM");
  });
}

export async function signIn(environment: PromoEnvironment, node: PromoNode): Promise<Session> {
  const response = await fetch(`${node.url}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: node.username, password: environment.password }) });
  if (!response.ok) throw new Error(`Sign in to node ${node.key} failed with ${response.status}`);
  const body = await response.json() as { csrfToken: string };
  return { cookie: (response.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; "), csrfToken: body.csrfToken };
}

export async function api<T>(node: PromoNode, session: Session, method: string, endpoint: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${node.url}/api${endpoint}`, {
    method,
    headers: { Cookie: session.cookie, "x-csrf-token": session.csrfToken, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body: parsed as T };
}

/** Pairs the laptop and the home server as twins through the real handshake, the laptop owning the projects. */
export async function pairTwins(environment: PromoEnvironment): Promise<void> {
  const [a, b] = environment.nodes;
  const [sessionA, sessionB] = await Promise.all([signIn(environment, a), signIn(environment, b)]);
  const invitation = await api<{ link: string; relationshipId: string }>(a, sessionA, "POST", "/twins/invitations", { confirmOwnedData: true });
  if (invitation.status !== 201) throw new Error(`Twin invitation failed: ${invitation.status} ${JSON.stringify(invitation.body)}`);
  const accepted = await api(b, sessionB, "POST", "/twins/accept", { link: invitation.body.link, confirmOwnedData: true });
  if (accepted.status !== 201) throw new Error(`Twin acceptance failed: ${accepted.status} ${JSON.stringify(accepted.body)}`);
  const sharing = await api(a, sessionA, "POST", `/twins/${invitation.body.relationshipId}/sharing`, { ownerNodeId: a.nodeId, confirmOwnedData: true });
  if (sharing.status !== 200) throw new Error(`Twin sharing failed: ${sharing.status} ${JSON.stringify(sharing.body)}`);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const listed = await api<{ projects: Array<{ id: string }> }>(b, sessionB, "GET", "/projects?syncStatus=false");
    if (a.projects.every((project) => listed.body.projects?.some((candidate) => candidate.id === project.id))) return;
    if (Date.now() > deadline) throw new Error("The home server never listed the laptop's projects");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
