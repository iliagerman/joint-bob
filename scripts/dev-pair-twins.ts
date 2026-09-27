// Pairs the two disposable dev nodes as twins through the real handshake, with node A
// owning the mirrored projects. `scripts/dev-local.sh cluster` runs it once both nodes
// answer; nodes that are already twins are left alone.
//
//   node --import tsx scripts/dev-pair-twins.ts <url-a> <url-b>
const [urlA, urlB] = process.argv.slice(2);
if (!urlA || !urlB) throw new Error("Usage: dev-pair-twins.ts <url-a> <url-b>");
const username = process.env.JOINT_BOB_DEV_USERNAME ?? "dev";
const password = process.env.JOINT_BOB_DEV_PASSWORD ?? "joint-bob-dev-password";

interface Session { url: string; cookie: string; csrf: string }

async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { if ((await fetch(`${url}/api/health`)).ok) return; } catch { /* The node is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${url} did not start`);
}

async function signIn(url: string): Promise<Session> {
  const response = await fetch(`${url}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
  if (!response.ok) throw new Error(`Sign in to ${url} failed: ${response.status}`);
  const cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  return { url, cookie, csrf: ((await response.json()) as { csrfToken: string }).csrfToken };
}

async function call<T>(session: Session, method: string, endpoint: string, body?: unknown): Promise<T> {
  const response = await fetch(`${session.url}/api${endpoint}`, {
    method, headers: { Cookie: session.cookie, "x-csrf-token": session.csrf, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`${method} ${endpoint} on ${session.url} failed: ${response.status} ${await response.text()}`);
  return await response.json() as T;
}

await Promise.all([waitForHealth(urlA), waitForHealth(urlB)]);
const [a, b] = await Promise.all([signIn(urlA), signIn(urlB)]);
const { relationships } = await call<{ relationships: Array<{ status: string }> }>(a, "GET", "/twins");
if (relationships.some((relationship) => relationship.status === "active")) {
  console.log("Dev nodes are already twins.");
} else {
  const { node } = await call<{ node: { id: string } }>(a, "GET", "/cluster/node");
  const invitation = await call<{ link: string; relationshipId: string }>(a, "POST", "/twins/invitations", { confirmOwnedData: true });
  await call(b, "POST", "/twins/accept", { link: invitation.link, confirmOwnedData: true });
  await call(a, "POST", `/twins/${invitation.relationshipId}/sharing`, { ownerNodeId: node.id, confirmOwnedData: true });
  console.log("Dev nodes paired as twins.");
}
