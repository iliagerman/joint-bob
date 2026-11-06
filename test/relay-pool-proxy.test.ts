import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import { getClusterNode } from "../src/cluster.js";
import { getOrCreateClusterIdentity } from "../src/cluster-identity.js";
import { ensureMembershipSchema } from "../src/cluster-membership.js";
import { addSharingMember, createSharingCluster } from "../src/cluster-sharing-policy.js";
import { clusterV2Database } from "../src/cluster-v2-store.js";
import { createSessionModelRuntime } from "../src/provider-profiles/pi.js";
import { PoolAttemptFailure } from "../src/provider-profiles/pool-execution.js";
import { forwardToProvider, RelayRouteRefused, relayProxyCredential } from "../src/provider-profiles/relay-proxy.js";
import type { ProviderProfile } from "../src/provider-profiles/store.js";

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }
async function serve(answer: (seen: Seen, response: http.ServerResponse) => void): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => { const entry = { method: request.method!, url: request.url!, headers: request.headers, body: Buffer.concat(chunks) }; seen.push(entry); answer(entry, response); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
const jwt = (claims: object) => `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;

test("the relay sends only model routes on, with its own sign-in in place of the member's placeholder", async () => {
  const upstream = await serve((_seen, response) => response.writeHead(200, { "content-type": "application/json" }).end("{}"));
  try {
    const body = Buffer.from(JSON.stringify({ model: "claude-sonnet-4", messages: [] }));
    const answer = await forwardToProvider("claude", "relay-access", { path: "/v1/messages?beta=true", body: body.toString("base64"),
      headers: { authorization: "Bearer sk-ant-oat01-placeholder", cookie: "session=member", "x-api-key": "member-key", "anthropic-beta": "oauth-2025-04-20", "content-type": "application/json" } },
    AbortSignal.timeout(5_000), upstream.url);
    assert.equal(answer.status, 200);
    const [sent] = upstream.seen;
    assert.equal(sent.url, "/v1/messages?beta=true");
    assert.equal(sent.headers.authorization, "Bearer relay-access", "the relay's own sign-in replaces the placeholder");
    assert.equal(sent.headers.cookie, undefined);
    assert.equal(sent.headers["x-api-key"], undefined);
    assert.equal(sent.headers["anthropic-beta"], "oauth-2025-04-20");
    assert.deepEqual(sent.body, body);

    for (const path of ["/api/oauth/claude_cli/create_api_key", "//attacker.example/v1/messages", "/v1/messages/../../api/oauth/profile", "/v1/files"]) {
      await assert.rejects(forwardToProvider("claude", "relay-access", { path, headers: {}, body: "" }, AbortSignal.timeout(5_000), upstream.url), RelayRouteRefused, path);
    }
    await assert.rejects(forwardToProvider("openai-codex", jwt({}), { path: "/v1/messages", headers: {}, body: "" }, AbortSignal.timeout(5_000), upstream.url), RelayRouteRefused);
    assert.equal(upstream.seen.length, 1, "a refused route never reaches the provider");

    const codexAccess = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "real-account" } });
    await forwardToProvider("openai-codex", codexAccess, { path: "/backend-api/codex/responses", body: "",
      headers: { authorization: "Bearer placeholder", "chatgpt-account-id": "joint-bob-relay", "content-encoding": "zstd" } }, AbortSignal.timeout(5_000), upstream.url);
    const codex = upstream.seen[1];
    assert.equal(codex.headers.authorization, `Bearer ${codexAccess}`);
    assert.equal(codex.headers["chatgpt-account-id"], "real-account", "the account comes from the relay's sign-in, not the placeholder");
  } finally { await upstream.close(); }
});

describeMemberProxy();

function describeMemberProxy(): void {
  const clusterId = randomUUID(), relayNodeId = randomUUID(), poolId = randomUUID();
  let relay: Awaited<ReturnType<typeof serve>>;
  let checkStatus = 200;
  before(async () => {
    relay = await serve((seen, response) => {
      const input = JSON.parse(seen.body.toString("utf8")) as { request?: { path: string; headers: Record<string, string>; body: string } };
      if (!input.request) { response.writeHead(checkStatus, { "content-type": "application/json" }).end(JSON.stringify(checkStatus === 200 ? { ready: true } : { error: "Not signed in on the relay" })); return; }
      response.writeHead(200, { "content-type": "text/event-stream", "request-id": "relay-request" });
      response.write("event: message_start\n\n");
      setTimeout(() => response.end("event: message_stop\n\n"), 20);
    });
    const local = await getClusterNode(), db = await clusterV2Database();
    getOrCreateClusterIdentity(db, local.id);
    ensureMembershipSchema(db);
    createSharingCluster(db, { id: clusterId, name: "Relay group" }, relayNodeId);
    addSharingMember(db, clusterId, relayNodeId, local.id, 1);
    db.prepare("INSERT INTO cluster_v2_membership_nodes VALUES(?,?,?,?,?,NULL)").run(clusterId, relayNodeId, "Relay", relay.url, "relay-key");
  });
  after(() => relay.close());
  const member = (provider: "claude" | "openai-codex") => {
    const profile: ProviderProfile = { id: randomUUID(), owner: "", label: `Team ${provider}`, provider, createdAt: "", shared: false };
    return { profile, context: { profileId: profile.id, provider, label: profile.label, poolId, clusterId, poolOwnerNodeId: relayNodeId } };
  };

  test("a member machine without the sign-in sends its turn's requests through the relay, which streams the answers back", async () => {
    const { profile, context } = member("claude");
    const credential = await relayProxyCredential(profile, context);
    assert.match(credential.access, /^sk-ant-oat01-[A-Za-z0-9_-]{43}$/);
    assert.match(credential.proxyBaseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    const check = JSON.parse(relay.seen.at(-1)!.body.toString("utf8"));
    assert.deepEqual(check, { clusterId, poolId, profileId: profile.id }, "the relay is asked before the turn starts, and no sign-in comes back");
    assert.ok(relay.seen.at(-1)!.headers.authorization, "the request to the relay is signed");
    assert.equal((await relayProxyCredential(profile, context)).access, credential.access, "the same pool member keeps its placeholder");

    assert.equal((await fetch(`${credential.proxyBaseUrl}/api/hello`, { method: "HEAD" })).status, 200, "Claude's reachability check is answered here");
    const before = relay.seen.length;
    const stranger = await fetch(`${credential.proxyBaseUrl}/v1/messages`, { method: "POST", headers: { authorization: "Bearer sk-ant-oat01-guess" }, body: "{}" });
    assert.equal(stranger.status, 401);
    assert.equal(relay.seen.length, before, "an unknown token never reaches the relay");

    const body = JSON.stringify({ model: "claude-sonnet-4", stream: true, messages: [{ role: "user", content: "hi" }] });
    const answer = await fetch(`${credential.proxyBaseUrl}/v1/messages?beta=true`, { method: "POST", body,
      headers: { authorization: `Bearer ${credential.access}`, "content-type": "application/json", "anthropic-version": "2023-06-01" } });
    assert.equal(answer.status, 200);
    assert.equal(answer.headers.get("content-type"), "text/event-stream");
    assert.equal(answer.headers.get("request-id"), "relay-request");
    assert.equal(await answer.text(), "event: message_start\n\nevent: message_stop\n\n");
    const forwarded = JSON.parse(relay.seen.at(-1)!.body.toString("utf8")) as { request: { path: string; headers: Record<string, string>; body: string } };
    assert.equal(forwarded.request.path, "/v1/messages?beta=true");
    assert.equal(Buffer.from(forwarded.request.body, "base64").toString("utf8"), body);
    assert.equal(forwarded.request.headers.authorization, undefined, "the placeholder stays on this machine");
    assert.equal(forwarded.request.headers.host, undefined);
    assert.equal(forwarded.request.headers["anthropic-version"], "2023-06-01");
  });

  test("a relay that refuses or cannot be reached stops the member before its turn starts, so the pool moves on", async () => {
    const { profile, context } = member("claude");
    checkStatus = 409;
    await assert.rejects(relayProxyCredential(profile, context), (error: unknown) => error instanceof PoolAttemptFailure && error.reason === "auth" && !error.started && /Not signed in on the relay/.test(error.message));
    checkStatus = 503;
    await assert.rejects(relayProxyCredential(profile, context), (error: unknown) => error instanceof PoolAttemptFailure && error.reason === "unavailable");
    checkStatus = 200;
    await assert.rejects(relayProxyCredential(profile, { ...context, poolOwnerNodeId: randomUUID() }), (error: unknown) => error instanceof PoolAttemptFailure && error.reason === "unavailable", "a relay that is not a member of the group is never asked");
  });

  test("Pi sends a relay member's model requests to the relay proxy", async () => {
    const claude = member("claude"), codex = member("openai-codex");
    const anthropic = await relayProxyCredential(claude.profile, claude.context);
    const chatgpt = await relayProxyCredential(codex.profile, codex.context);
    assert.match(chatgpt.proxyBaseUrl, /\/backend-api$/);
    const claims = JSON.parse(Buffer.from(chatgpt.access.split(".")[1], "base64url").toString("utf8"));
    assert.equal(claims["https://api.openai.com/auth"].chatgpt_account_id, "joint-bob-relay", "Pi finds an account in the placeholder; the relay sets the real one");
    const credentials = { anthropic, "openai-codex": chatgpt } as Record<string, typeof anthropic>;
    const runtime = await createSessionModelRuntime(async (provider) => credentials[provider],
      async () => [{ providerId: "anthropic", type: "oauth" }, { providerId: "openai-codex", type: "oauth" }]);
    const claudeAuth = await runtime.getAuth(runtime.getModels("anthropic")[0]);
    assert.equal(claudeAuth?.auth.apiKey, anthropic.access);
    assert.equal(claudeAuth?.auth.baseUrl, anthropic.proxyBaseUrl);
    assert.equal((await runtime.getAuth("openai-codex"))?.auth.baseUrl, chatgpt.proxyBaseUrl);

    const before = relay.seen.length;
    const reply = await runtime.complete(runtime.getModels("anthropic")[0], { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] });
    assert.ok(relay.seen.length > before, `Pi's request reached the relay (${reply.stopReason})`);
    const forwarded = JSON.parse(relay.seen.at(-1)!.body.toString("utf8")) as { request: { path: string } };
    assert.match(forwarded.request.path, /^\/v1\/messages/);
  });
}

test("a pool member signed in on this machine uses its own sign-in, not the relay proxy", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const { createProviderProfile, providerProfile } = await import("../src/provider-profiles/store.js");
  const { openAIAuthPath, profileAccessCredential } = await import("../src/provider-profiles/service.js");
  const { withPoolProfile } = await import("../src/provider-profiles/context.js");
  const owner = `pool-member-${randomUUID()}`;
  const profile = createProviderProfile(owner, { provider: "openai-codex", label: "Own sign-in" });
  assert.ok(providerProfile(owner, profile.id));
  await mkdir(path.dirname(openAIAuthPath(profile)), { recursive: true, mode: 0o700 });
  await writeFile(openAIAuthPath(profile), JSON.stringify({ "openai-codex": { type: "oauth", access: "member-own-access", refresh: "member-own-refresh", expires: Date.now() + 3 * 60 * 60_000 } }), { mode: 0o600 });
  const context = { profileId: profile.id, provider: "openai-codex" as const, label: profile.label, poolId: randomUUID(), clusterId: randomUUID(), poolOwnerNodeId: randomUUID() };
  const credential = await withPoolProfile(context, () => profileAccessCredential(profile));
  assert.equal(credential.access, "member-own-access", "the member's own sign-in is used, so no relay request is made");
});
