import type { ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { chromium, type Browser } from "playwright-core";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

// Repository UI tests only: synthetic accounts, loopback nodes, fresh Chrome context.
export async function nativeUiFixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "joint-bob-native-ui-")));
  let server: ChildProcess | undefined;
  let browser: Browser | undefined;
  t.after(async () => {
    try {
      await browser?.close();
    } finally {
      try {
        if (server) await stopDevNode(server);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  server = await startDevNode(environment, node);
  browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? "chrome", headless: true, env: { ...process.env, HOME: environment.home } });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  context.setDefaultTimeout(20_000);
  const page = await context.newPage();
  return { page, environment, node };
}
