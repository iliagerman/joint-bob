import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import test from "node:test";
import { waitForDevNode } from "./dev-nodes.js";

test("a listening server is not returned until application health is ready", async () => {
  let ready = false;
  let settled = false;
  let sawRequest: () => void = () => {};
  const requested = new Promise<void>((resolve) => { sawRequest = resolve; });
  const server = createServer((_request, response) => {
    response.statusCode = ready ? 200 : 503;
    response.end();
    sawRequest();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { process } = child();
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const pending = waitForDevNode(process, "health", `http://127.0.0.1:${address.port}`).then((value) => { settled = true; return value; });
  try {
    process.stdout!.emit("data", "Joint Bob listening");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "the listening log precedes application startup readiness");
    await requested;
    assert.equal(settled, false);
    ready = true;
    assert.equal(await pending, process);
  } finally {
    process.emit("exit", 1);
    await pending.catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function child() {
  const process = new EventEmitter() as ChildProcess;
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  process.kill = (signal) => { signals.push(signal); return true; };
  return { process, signals };
}

test("startup timeout terminates the unreturned server rather than hanging the suite", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { process, signals } = child();
  const pending = waitForDevNode(process, "timeout");
  const rejected = assert.rejects(pending, /startup timed out/);
  t.mock.timers.tick(60_000);
  await rejected;
  assert.deepEqual(signals, ["SIGKILL"]);
  assert.equal(process.listenerCount("error"), 0);
});

test("early exit clears startup timeout and reports buffered diagnostics", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { process, signals } = child();
  const pending = waitForDevNode(process, "exit");
  process.stderr!.emit("data", "startup fixture failed");
  process.emit("exit", 1);
  await assert.rejects(pending, /startup fixture failed/);
  t.mock.timers.tick(60_000);
  assert.deepEqual(signals, []);
  assert.equal(process.listenerCount("exit"), 0);
});

test("readiness split between stdout chunks resolves without a later timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { process, signals } = child();
  const pending = waitForDevNode(process, "split");
  process.stdout!.emit("data", "Joint Bob list");
  process.stdout!.emit("data", "ening on http://127.0.0.1:1234\n");
  t.mock.timers.tick(60_000);
  assert.equal(await pending, process);
  assert.deepEqual(signals, []);
  assert.equal(process.listenerCount("exit"), 0);
});
