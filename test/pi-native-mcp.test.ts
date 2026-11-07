import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { piSdkEntry } from "../src/pi-sdk.js";
import { nativeMcpFixture, nativeCallback } from "./native-mcp-fixture.js";

const selected = piSdkEntry ?? import.meta.resolve("@earendil-works/pi-coding-agent");
const sdk = await import(selected);
const native = { skip: typeof sdk.createMcpExtension !== "function" ? "Selected Pi lacks native MCP; run with a managed Pi SDK to verify native OAuth" : false };

test("native Pi support reports an actionable error for an older SDK", async () => {
  const { loadPiNativeMcp } = await import("../src/mcp/pi-native.js");
  await assert.rejects(loadPiNativeMcp(import.meta.resolve("./native-mcp-fixture.js")), /Update the Pi harness.*native MCP/);
});

test("native Pi signs in, persists for real tools, rejects cross-flow callbacks, and signs out", native, async () => {
  const { createPiNativeMcp } = await import("../src/mcp/pi-native.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-native-mcp-")), fixture = await nativeMcpFixture();
  const config = { fixture: { url: `${fixture.origin}/mcp` } };
  const alice = await createPiNativeMcp(config, path.join(root, "alice"), root);
  const bob = await createPiNativeMcp(config, path.join(root, "bob"), root);
  let reopened: typeof alice | undefined;
  try {
    assert.equal((await alice.status())[0].status, "needs-auth");
    assert.equal(fixture.registrations(), 0, "status cannot start OAuth");
    const start = await alice.start("fixture"); assert.ok(start.authUrl);
    const callback = nativeCallback(start.authUrl), forged = new URL(callback); forged.searchParams.set("state", "forged");
    await assert.rejects(alice.finish(forged.href), /Invalid MCP sign-in callback/);
    await assert.rejects(bob.finish(callback.href), /No Pi MCP sign-in/);
    assert.equal((await alice.finish(callback.href)).status, "connected");
    assert.equal((await alice.call("fixture", "inspect", {})).content[0].text, "Native authenticated call");
    await alice.close();
    reopened = await createPiNativeMcp(config, path.join(root, "alice"), root);
    assert.equal((await reopened.status())[0].status, "connected");
    await reopened.call("fixture", "inspect", {});
    assert.equal(fixture.calls(), 2);
    assert.equal((await bob.status())[0].status, "needs-auth");
    assert.equal((await stat(path.join(root, "alice", "mcp-auth.json"))).mode & 0o777, 0o600);
    await reopened.signOut("fixture");
    assert.equal((await reopened.status())[0].status, "needs-auth");
  } finally { await alice.close(); await bob.close(); await reopened?.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); }
});

test("native Pi reports denied registration without switching clients or saving a grant", native, async () => {
  const { createPiNativeMcp } = await import("../src/mcp/pi-native.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-native-denied-")), fixture = await nativeMcpFixture({ rejectRegistration: true });
  const client = await createPiNativeMcp({ fixture: { url: `${fixture.origin}/mcp` } }, root, root);
  try {
    await assert.rejects(client.start("fixture"), /Native Pi MCP sign-in failed/);
    assert.equal((await client.status())[0].status, "needs-auth");
    assert.equal(fixture.registrations(), 1);
    await assert.rejects(client.call("fixture", "inspect", {}));
  } finally { await client.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); }
});

test("native Pi cancellation stops the callback listener without saving a grant", native, async () => {
  const { createPiNativeMcp } = await import("../src/mcp/pi-native.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-native-cancel-")), fixture = await nativeMcpFixture();
  const client = await createPiNativeMcp({ fixture: { url: `${fixture.origin}/mcp` } }, root, root);
  try {
    const { authUrl } = await client.start("fixture"); assert.ok(authUrl);
    await client.cancel();
    await assert.rejects(client.finish(nativeCallback(authUrl).href), /No Pi MCP sign-in/);
    await assert.rejects(fetch(nativeCallback(authUrl)), /fetch failed/);
    assert.equal((await client.status())[0].status, "needs-auth");
  } finally { await client.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); }
});
