import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { classifyPoolAttemptFailure, PoolAttemptFailure } from "../src/provider-profiles/pool-execution.js";

const require = createRequire(import.meta.url);
const HOUR = 60 * 60_000;

/** The production borrowing code, with the twin network and cluster database replaced. */
function borrowing(lend: (twin: string) => { access: string; expires: number } | Error) {
  const online = { twins: ["Mac"] };
  const asked: string[] = [];
  const source = readFileSync(new URL("../src/provider-profiles/twin-login.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mocks: Record<string, any> = {
    z: require("zod").z, PoolAttemptFailure,
    getClusterNode: async () => ({ id: "homeserver" }), clusterV2Database: async () => ({}), isTrustedTwin: () => true,
    presentReplicationPeers: () => online.twins.map((name) => ({ nodeId: name, name })),
    signedPeerPost: async (twin: { name: string }) => {
      asked.push(twin.name);
      const lent = lend(twin.name);
      if (lent instanceof Error) throw lent;
      return { credential: { type: "oauth", refresh: "", ...lent } };
    },
  };
  const exports: any = {};
  vm.runInThisContext(`(function(require, exports) { ${compiled}\n})`)((name: string) => name.startsWith("node:") ? require(name)
    : new Proxy(mocks, { get(target, key: string) { if (key in target) return target[key]; throw new Error(`Unexpected boundary ${name}:${key}`); } }), exports);
  return { exports, online, asked };
}
const claude = { id: "sela", owner: "owner", label: "claude - sela", provider: "claude", createdAt: "", shared: false };

// 2026-11-05: the Mac holding every Claude sign-in went offline. The homeserver, its twin, failed
// each turn with "Sign in again on this node, or on a twin that is online", and a turn already
// running died with 401 when its borrowed token expired 45 minutes in.
test("with the lending twin offline, a token borrowed earlier keeps serving until it nearly expires", async () => {
  let expires = Date.now() + 3 * HOUR;
  const { exports, online, asked } = borrowing(() => ({ access: "lent", expires }));
  assert.equal((await exports.borrowTwinCredential(claude)).access, "lent");
  online.twins = [];
  expires = 0;
  assert.equal((await exports.borrowTwinCredential(claude)).access, "lent", "three hours left: no need to ask");
  assert.deepEqual(asked, ["Mac"]);
});

test("a Claude turn starts on a token that lasts hours: a shorter one is replaced while the twin is online", async () => {
  let token = { access: "short", expires: Date.now() + HOUR };
  const { exports, asked } = borrowing(() => token);
  assert.equal((await exports.borrowTwinCredential(claude)).access, "short", "the only token there is");
  token = { access: "fresh", expires: Date.now() + 5 * HOUR };
  assert.equal((await exports.borrowTwinCredential(claude)).access, "fresh", "an hour left is too little for a Claude turn");
  assert.deepEqual(asked, ["Mac", "Mac"]);
  assert.equal(exports.turnTokenValidityMs(claude), 2 * HOUR);
  assert.equal(exports.turnTokenValidityMs({ ...claude, provider: "openai-codex" }), 10 * 60_000, "Pi renews other tokens itself during a turn");
});

test("with no sign-in here and no twin online, the error says to sign in on this node too, and a pool moves on", async () => {
  const { exports, online } = borrowing(() => assert.fail("no twin is online"));
  online.twins = [];
  const error = await exports.borrowTwinCredential(claude).then(() => assert.fail("must not borrow"), (failure: unknown) => failure);
  assert.ok(error instanceof PoolAttemptFailure);
  assert.equal(error.message, "claude - sela is not signed in on this node, and no twin that could lend its sign-in is online. Sign in to claude - sela on this node too (Settings → Profiles) so turns here keep working while your other machines are offline. No other account was used.");
  assert.equal(classifyPoolAttemptFailure(error, false)?.reason, "auth", "the next pool member is tried");
});

test("an online twin that cannot lend is named in the error", async () => {
  const { exports } = borrowing(() => new Error("Sign in to claude - sela again on this node"));
  await assert.rejects(exports.borrowTwinCredential(claude), /no online twin could lend its sign-in \(Mac: Sign in to claude - sela again on this node\)\. Sign in to claude - sela on this node too/);
});
