import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("node-local profile API validates scopes, protects secrets, and refuses selected deletion", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "provider-profile-api-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node, { JOINT_BOB_TEST_MULTI_USER_READY: "1" });
  try {
    const session = await signIn(environment, node);
    const created = await api<{ profile: { id: string; label: string } }>(node, session, "POST", "/provider-profiles", { provider: "openai-codex", label: "Personal" });
    assert.equal(created.status, 201);
    const id = created.body.profile.id;
    const listed = await api<{ profiles: Array<{ id: string }> }>(node, session, "GET", "/provider-profiles");
    assert.deepEqual(listed.body.profiles.map((item) => item.id), [id]);
    assert.doesNotMatch(JSON.stringify(listed.body), /refreshToken|accessToken|auth\.json/);
    const memberCreated = await api<{ oneTimePassword: string }>(node, session, "POST", "/users", { username: "profile-member", email: "profile-member@example.test" });
    assert.equal(memberCreated.status, 201);
    const login = await fetch(`${node.url}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "profile-member", password: memberCreated.body.oneTimePassword }) });
    assert.equal(login.status, 200);
    const member = { cookie: login.headers.get("set-cookie")!.split(";")[0], csrfToken: (await login.json() as { csrfToken: string }).csrfToken };
    const changed = await fetch(`${node.url}/api/auth/change-password`, { method: "POST", headers: { Cookie: member.cookie, "x-csrf-token": member.csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: memberCreated.body.oneTimePassword, newPassword: "synthetic-provider-profile-password" }) });
    assert.equal(changed.status, 204);
    const memberList = await api<{ profiles: Array<{ id: string }> }>(node, member, "GET", "/provider-profiles");
    assert.deepEqual(memberList.body.profiles, []);
    for (const [method, endpoint, body] of [
      ["GET", `/provider-profiles/${id}/status`, undefined],
      ["POST", `/provider-profiles/${id}/login`, {}],
      ["POST", `/provider-profiles/${id}/logout`, {}],
      ["PUT", `/provider-profiles/${id}/sharing`, { shared: true }],
      ["DELETE", `/provider-profiles/${id}`, undefined],
    ] as const) assert.equal((await api(node, member, method, endpoint, body)).status, 404);
    assert.equal((await api(node, member, "PUT", "/provider-profiles/selection", { provider: "openai-codex", scope: "default", scopeId: "", profileId: id })).status, 404);
    assert.equal((await api(node, session, "PUT", `/provider-profiles/${id}/sharing`, { shared: true })).status, 200);
    const interactive = await api<{ profiles: Array<{ id: string }> }>(node, session, "GET", "/provider-profiles/available?usage=interactive");
    assert.equal(interactive.body.profiles.some((item) => item.id === id), false);
    const automation = await api<{ profiles: Array<{ id: string }> }>(node, session, "GET", "/provider-profiles/available?usage=automation");
    assert.equal(automation.body.profiles.some((item) => item.id === id), true);
    const memberAutomation = await api<{ profiles: Array<{ id: string }> }>(node, member, "GET", "/provider-profiles/available?usage=automation");
    assert.equal(memberAutomation.body.profiles.some((item) => item.id === id), true);
    assert.equal((await api(node, member, "GET", `/provider-profiles/${id}/status`)).status, 404);
    assert.equal((await api(node, member, "PUT", `/provider-profiles/${id}/sharing`, { shared: false })).status, 404);
    assert.equal((await api(node, session, "PUT", "/provider-profiles/selection", { provider: "openai-codex", scope: "default", scopeId: "", profileId: id })).status, 409);
    assert.equal((await api(node, session, "PUT", `/provider-profiles/${id}/sharing`, { shared: false })).status, 200);
    const state = await api<{ signedIn: boolean }>(node, session, "GET", `/provider-profiles/${id}/status`);
    assert.equal(state.body.signedIn, false);
    const invalid = await api(node, session, "PUT", "/provider-profiles/selection", { provider: "openai-codex", scope: "project", scopeId: "nonexistent", profileId: id });
    assert.equal(invalid.status, 404);
    const selected = await api(node, session, "PUT", "/provider-profiles/selection", { provider: "openai-codex", scope: "default", scopeId: "", profileId: id });
    assert.equal(selected.status, 200);
    assert.equal((await api(node, session, "DELETE", `/provider-profiles/${id}`)).status, 409);
    assert.equal((await api(node, session, "PUT", "/provider-profiles/selection", { provider: "openai-codex", scope: "default", scopeId: "", profileId: null })).status, 200);
    assert.equal((await api(node, session, "DELETE", `/provider-profiles/${id}`)).status, 200);
    assert.equal((await api(node, session, "GET", `/provider-profiles/${id}/status`)).status, 404);
  } finally { await stopDevNode(server); await rm(root, { recursive: true, force: true }); }
});
