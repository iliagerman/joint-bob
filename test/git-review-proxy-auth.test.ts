import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// A peer that rejects our machine token (401/403) is a node-to-node auth problem, not the
// browser user's session expiring. The client's api() calls showSignedOut() on any 401, so
// forwarding a peer 401 straight through pops a spurious login dialog — the exact symptom
// reported for the git panel across nodes. The proxy must translate it to a non-401 status.
test("the git review proxy never forwards a peer 401/403 to the browser", async () => {
  const source = await readFile("src/server/routes/git-review.ts", "utf8");
  const proxyStart = source.indexOf("async function proxyGitJson");
  assert.ok(proxyStart >= 0, "proxyGitJson must exist");
  const proxyEnd = source.indexOf("\n}", proxyStart);
  const proxy = source.slice(proxyStart, proxyEnd);

  // It must special-case 401/403 and respond with a different status (502), not pass through.
  assert.match(proxy, /routed\.status === 401 \|\| routed\.status === 403/, "proxy must detect a peer auth rejection");
  assert.match(proxy, /response\.status\(502\)/, "a peer auth rejection is reported as an upstream failure, not a 401");
  // The generic pass-through must come after the 401/403 guard returns, so a 401 can never reach it.
  const guardIndex = proxy.indexOf("routed.status === 401");
  const passthroughIndex = proxy.indexOf("response.status(routed.status).send");
  assert.ok(guardIndex >= 0 && passthroughIndex >= 0 && guardIndex < passthroughIndex, "the 401/403 guard must precede the raw pass-through");
});
