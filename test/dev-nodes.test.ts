import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { stopDevNode } from "./dev-nodes.js";

test("dev-node cleanup allows the application's eight-second graceful shutdown budget", { timeout: 15000 }, async () => {
  const child = spawn(process.execPath, ["-e", `
    process.once("SIGTERM", () => setTimeout(() => process.exit(0), 6000));
    console.log("ready");
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await once(child.stdout!, "data");
    await stopDevNode(child);
    assert.equal(child.signalCode, null, "Do not force-kill before the application's shutdown deadline");
    assert.equal(child.exitCode, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
});
