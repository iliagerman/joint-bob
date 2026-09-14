import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createKiroConnection } from "../src/harnesses/kiro/transport.js";

type RecordValue = Record<string, unknown>;

function fakeChild() {
  const emitter = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const records: RecordValue[] = [];
  let input = "";
  stdin.on("data", (chunk: Buffer) => {
    input += chunk.toString();
    const lines = input.split("\n");
    input = lines.pop() ?? "";
    records.push(...lines.filter(Boolean).map((line) => JSON.parse(line) as RecordValue));
  });
  Object.assign(emitter, { stdin, stdout, stderr, killed: false, exitCode: null, signalCode: null });
  emitter.kill = (() => {
    emitter.killed = true;
    return true;
  }) as ChildProcessWithoutNullStreams["kill"];
  return { child: emitter, records };
}

async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function createCallbacks() {
  return {
    onNotification: (_method: string, _params: unknown) => undefined,
    onRequest: async (_method: string, _params: unknown) => null,
  };
}

test("correlates out-of-order replies and preserves null results across chunks", async () => {
  const { child, records } = fakeChild();
  const connection = createKiroConnection(child, createCallbacks().onNotification, createCallbacks().onRequest);
  const first = connection.request("first", { value: 1 });
  const second = connection.request("second", { value: 2 });
  assert.deepEqual(records, [
    { jsonrpc: "2.0", id: 1, method: "first", params: { value: 1 } },
    { jsonrpc: "2.0", id: 2, method: "second", params: { value: 2 } },
  ]);

  child.stdout.write(Buffer.from('{"jsonrpc":"2.0","id":2,"result":null}\n{"jsonrpc":"2.0","id":1,'));
  child.stdout.write(Buffer.from('"result":"done"}\n'));
  assert.equal(await second, null);
  assert.equal(await first, "done");
});

test("preserves UTF-8 code points split between stdout chunks", async () => {
  const { child } = fakeChild();
  const connection = createKiroConnection(child, createCallbacks().onNotification, createCallbacks().onRequest);
  const pending = connection.request("emoji", null);
  const text = "hello 😀 world";
  const reply = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: text })}\n`);
  const emoji = Buffer.from("😀");
  const splitAt = reply.indexOf(emoji) + 2;
  child.stdout.write(reply.subarray(0, splitAt));
  child.stdout.write(reply.subarray(splitAt));
  assert.equal(await pending, text);
});

test("writes notifications without an id or pending request", async () => {
  const { child, records } = fakeChild();
  const connection = createKiroConnection(child, createCallbacks().onNotification, createCallbacks().onRequest);
  connection.notify("changed", { ready: true });
  assert.deepEqual(records, [{ jsonrpc: "2.0", method: "changed", params: { ready: true } }]);
  child.stdout.write(Buffer.from('{"jsonrpc":"2.0","id":1,"result":true}\n'));
  await turn();
  assert.equal(child.killed, true);
});

test("forwards server notifications", async () => {
  const { child } = fakeChild();
  const received: unknown[] = [];
  createKiroConnection(child, (method, params) => received.push([method, params]), createCallbacks().onRequest);
  child.stdout.write(Buffer.from('{"jsonrpc":"2.0","method":"progress","params":{"n":3}}\n'));
  await turn();
  assert.deepEqual(received, [["progress", { n: 3 }]]);
});

test("answers server requests with results and internal errors", async () => {
  const { child, records } = fakeChild();
  createKiroConnection(child, createCallbacks().onNotification, async (method) => {
    if (method === "fail") throw new Error("permission broke");
    return { allowed: true };
  });
  child.stdout.write(Buffer.from('{"jsonrpc":"2.0","id":"a","method":"allow","params":{}}\n'));
  await turn();
  child.stdout.write(Buffer.from('{"jsonrpc":"2.0","id":7,"method":"fail","params":null}\n'));
  await turn();
  assert.deepEqual(records, [
    { jsonrpc: "2.0", id: "a", result: { allowed: true } },
    { jsonrpc: "2.0", id: 7, error: { code: -32603, message: "permission broke" } },
  ]);
});

test("an error reply rejects only its matching request", async () => {
  const { child } = fakeChild();
  const connection = createKiroConnection(child, createCallbacks().onNotification, createCallbacks().onRequest);
  const failed = connection.request("bad", null);
  const sibling = connection.request("good", null);
  child.stdout.write(Buffer.from('{"jsonrpc":"2.0","id":1,"error":{"code":9,"message":"denied"}}\n'));
  await assert.rejects(failed, /denied/);
  child.stdout.write(Buffer.from('{"jsonrpc":"2.0","id":2,"result":"ok"}\n'));
  assert.equal(await sibling, "ok");
  assert.equal(child.killed, false);
});

for (const [name, line] of [
  ["malformed JSON", "not-json\n"],
  ["invalid envelope", '{"jsonrpc":"1.0","method":"notice"}\n'],
  ["unknown reply ID", '{"jsonrpc":"2.0","id":99,"result":true}\n'],
] as const) {
  test(`${name} rejects pending requests and kills the child`, async () => {
    const { child } = fakeChild();
    const connection = createKiroConnection(child, createCallbacks().onNotification, createCallbacks().onRequest);
    const pending = connection.request("waiting", null);
    child.stdout.write(Buffer.from(line));
    await assert.rejects(pending);
    assert.equal(child.killed, true);
  });
}

test("notification callback failures terminate the connection", async () => {
  const { child } = fakeChild();
  const connection = createKiroConnection(child, () => { throw new Error("listener failed"); }, createCallbacks().onRequest);
  const pending = connection.request("waiting", null);
  child.stdout.write(Buffer.from('{"jsonrpc":"2.0","method":"notice","params":null}\n'));
  await assert.rejects(pending, /listener failed/);
  assert.equal(child.killed, true);
});

test("exit before stdout drains preserves the final response", async () => {
  const { child } = fakeChild();
  const connection = createKiroConnection(child, createCallbacks().onNotification, createCallbacks().onRequest);
  const pending = connection.request("waiting", null);
  child.emit("exit", 0, null);
  child.stdout.write(Buffer.from('{"jsonrpc":"2.0","id":1,"result":"done"}\n'));
  child.emit("close", 0, null);
  assert.equal(await pending, "done");
  await connection.closed;
});

test("process exit includes bounded stderr and closed resolves", async () => {
  const { child } = fakeChild();
  const connection = createKiroConnection(child, createCallbacks().onNotification, createCallbacks().onRequest);
  const pending = connection.request("waiting", null);
  child.stderr.write(Buffer.from(`discard${"x".repeat(2000)}`));
  child.emit("exit", 1, null);
  child.emit("close", 1, null);
  const error = await pending.then(() => null, (reason: Error) => reason);
  assert.ok(error);
  assert.match(error.message, /exited with code 1/);
  assert.equal(error.message.includes("discard"), false);
  assert.equal(error.message.endsWith("x".repeat(2000)), true);
  await connection.closed;
});

test("child errors reject outstanding and future requests immediately", async () => {
  const { child } = fakeChild();
  const connection = createKiroConnection(child, createCallbacks().onNotification, createCallbacks().onRequest);
  const pending = connection.request("waiting", null);
  child.emit("error", new Error("spawn failed"));
  await assert.rejects(pending, /spawn failed/);
  await assert.rejects(connection.request("later", null), /spawn failed/);
  assert.throws(() => connection.notify("later", null), /spawn failed/);
  await connection.closed;
});
