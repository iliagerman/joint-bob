import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { machineRoutes } from "../src/server/state.js";

// A peer reaches another machine's Git routes only through the signed runtime proxy, which refuses any route
// missing from `machineRoutes` with "Unsupported signed runtime route". Every cluster Git route must be listed.
test("every cluster Git route can be called by a peer", async () => {
  const folder = path.join(import.meta.dirname, "../src/server/routes");
  const registered: string[] = [];
  for (const file of await readdir(folder)) {
    const source = await readFile(path.join(folder, file), "utf8");
    for (const [, method, route] of source.matchAll(/app\.(get|post|put|delete)\("\/api(\/cluster\/git\/[^"]+)"/g)) registered.push(`${method.toUpperCase()} ${route}`);
  }
  assert.ok(registered.includes("POST /cluster/git/overview"), "the scan finds the routes");
  assert.deepEqual(registered.filter((route) => !machineRoutes.has(route)), []);
});
