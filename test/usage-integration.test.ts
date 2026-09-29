import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import type { ChildProcess } from "node:child_process";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";

let root: string; let environment: DevEnvironment; let node: SeededNode; let session: SignedIn; let child: ChildProcess;
before(async () => { root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-usage-integration-")); environment = await seedDevEnvironment(root, 1); node = environment.nodes[0]; child = await startDevNode(environment, node); session = await signIn(environment, node); });
after(async () => { if (child) await stopDevNode(child); if (root) await rm(root, { recursive: true, force: true }); });

test("usage API rejects unauthenticated fetch", async () => assert.equal((await fetch(`${node.url}/api/usage`)).status, 401));
test("usage API rejects malformed and reversed dates", async () => {
  assert.equal((await api(node, session, "GET", "/usage?from=2025-99-01")).status, 400);
  assert.equal((await api(node, session, "GET", "/usage?from=2025-02-02&to=2025-01-01")).status, 400);
});
test("usage API rejects an unknown project", async () => assert.equal((await api(node, session, "GET", "/usage?projectId=unknown")).status, 404));
test("usage refresh requires CSRF", async () => assert.equal((await fetch(`${node.url}/api/usage/refresh`, { method: "POST", headers: { Cookie: session.cookie } })).status, 403));
test("manual subscription persists, validates price, and deletes", async () => {
  const payload = { provider: "anthropic", accountLabel: "work", planName: "Max", price: { amount: 200, currency: "USD", billingPeriod: "month" }, renewalAt: null, quotaWindows: [], status: "available", source: "manual" };
  const saved = await api<{ id: string }>(node, session, "PUT", "/subscription-usage", payload); assert.equal(saved.status, 200);
  const listed = await api<{ plans: Array<{ id: string; price: { amount: number } }> }>(node, session, "GET", "/subscription-usage"); assert.equal(listed.body.plans[0].price.amount, 200);
  assert.equal((await api(node, session, "PUT", "/subscription-usage", { ...payload, price: { ...payload.price, amount: -1 } })).status, 400);
  const response = await fetch(`${node.url}/api/subscription-usage/${saved.body.id}`, { method: "DELETE", headers: { Cookie: session.cookie, "x-csrf-token": session.csrfToken } }); assert.equal(response.status, 204);
});
test("custom label filter is accepted and accounts are not exposed", async () => {
  const response = await api<Record<string, unknown>>(node, session, "GET", "/usage?classification=Custom%20label"); assert.equal(response.status, 200); assert.equal("accounts" in response.body, false);
});
