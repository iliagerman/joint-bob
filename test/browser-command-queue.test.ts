import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserCommandQueue } from "../src/browser-command-queue.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("interactive jobs precede queued background jobs without overlapping", async () => {
  const queue = new BrowserCommandQueue();
  const gate = deferred();
  const starts: string[] = [];
  let active = 0;
  const run = (priority: "interactive" | "background", name: string, wait?: Promise<void>) => queue.run(priority, async () => {
    starts.push(name); active++; assert.equal(active, 1);
    if (wait) await wait;
    active--; return `${name}-result`;
  });

  const first = run("background", "active", gate.promise);
  const backgroundB = run("background", "B");
  const interactiveA1 = run("interactive", "A1");
  const interactiveA2 = run("interactive", "A2");
  const backgroundC = run("background", "C");
  gate.resolve();

  assert.deepEqual(await Promise.all([first, backgroundB, interactiveA1, interactiveA2, backgroundC]), ["active-result", "B-result", "A1-result", "A2-result", "C-result"]);
  assert.deepEqual(starts, ["active", "A1", "A2", "B", "C"]);
});

test("a failed job rejects its caller and does not block later jobs", async () => {
  const queue = new BrowserCommandQueue();
  const original = new Error("original failure");
  const failed = queue.run("interactive", async () => { throw original; });
  const next = queue.run("interactive", async () => "continued");
  await assert.rejects(failed, error => error === original);
  assert.equal(await next, "continued");
});

test("close rejects pending and new jobs while active work finishes", async () => {
  const queue = new BrowserCommandQueue();
  const gate = deferred();
  const active = queue.run("background", async () => { await gate.promise; return "finished"; });
  let sideEffects = 0;
  const pendingA = queue.run("interactive", async () => { sideEffects++; });
  const pendingB = queue.run("background", async () => { sideEffects++; });
  const rejectedA = assert.rejects(pendingA, /session stopped/);
  const rejectedB = assert.rejects(pendingB, /session stopped/);
  const error = new Error("session stopped");
  queue.close(error);
  await Promise.all([rejectedA, rejectedB]);
  await assert.rejects(queue.run("interactive", async () => { sideEffects++; }), value => value === error);
  queue.close(new Error("different"));
  assert.equal(sideEffects, 0);
  gate.resolve();
  assert.equal(await active, "finished");
  assert.equal(sideEffects, 0);
});
