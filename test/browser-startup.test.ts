import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { seedDevEnvironment, startDevNode, stopDevNode } from "./dev-nodes.js";

test("startup begins browser recovery without a viewer and does not block the app", { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-startup-"));
  const marker = path.join(root, "recovery-started");
  const probe = path.join(root, "recovery-probe.mjs");
  const runtimeUrl = pathToFileURL(path.resolve("src/browser-runtime.ts")).href;
  await writeFile(probe, `import { writeFileSync } from 'node:fs';
import { BrowserRuntime } from ${JSON.stringify(runtimeUrl)};
BrowserRuntime.prototype.ready = function () { writeFileSync(${JSON.stringify(marker)}, 'started'); return new Promise(() => {}); };
`);
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node, { NODE_OPTIONS: `--import tsx --import ${pathToFileURL(probe).href}` });
  try {
    const response = await fetch(`${node.url}/api/auth/status`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, "A pending browser restore must not block ordinary app requests");
    assert.equal(existsSync(marker), true, "Recovery must begin at startup, before any browser request");
  } finally { await stopDevNode(server); await rm(root, { recursive: true, force: true }); }
});
