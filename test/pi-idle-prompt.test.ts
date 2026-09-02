import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promptIdlePiSession, type PiSessionHandle } from "../src/pi-service.js";

/** A Pi session double that reports busy state on demand and rejects prompts
    exactly the way the SDK does while a turn is running. */
function fakePiSession(startBusy: boolean, promptImpl?: (text: string) => Promise<void>) {
  const state = { streaming: startBusy };
  const listeners = new Set<() => void>();
  const prompts: string[] = [];
  const session = {
    get isStreaming() { return state.streaming; },
    isBashRunning: false,
    isCompacting: false,
    isRetrying: false,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    async prompt(text: string) {
      if (state.streaming) throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
      prompts.push(text);
    },
  };
  if (promptImpl) (session as { prompt: (text: string) => Promise<void> }).prompt = promptImpl;
  return {
    handle: { session } as unknown as PiSessionHandle,
    prompts,
    startTurn() { state.streaming = true; },
    endTurn() { state.streaming = false; for (const listener of listeners) listener(); },
    emitWhileStreaming() { for (const listener of listeners) listener(); },
  };
}

test("a task prompt waits for the running turn to finish before it is sent", async () => {
  const fake = fakePiSession(true);
  const sent = promptIdlePiSession(fake.handle, "next phase");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(fake.prompts, [], "prompted while the session was still streaming");
  fake.emitWhileStreaming();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(fake.prompts, [], "prompted on an event that did not end the turn");
  fake.endTurn();
  await sent;
  assert.deepEqual(fake.prompts, ["next phase"]);
});

test("a task prompt that loses a race with a user message waits and retries", async () => {
  let calls = 0;
  const fake = fakePiSession(false, async (text) => {
    calls += 1;
    if (calls === 1) {
      // The session looked idle, but a user message started a turn in the gap
      // between the busy check and the prompt call: the SDK rejects once, the
      // user turn then finishes and the task prompt must go through after it.
      fake.startTurn();
      setTimeout(() => fake.endTurn(), 5);
      throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
    }
    fake.prompts.push(text);
  });
  await promptIdlePiSession(fake.handle, "next phase");
  assert.equal(calls, 2);
  assert.deepEqual(fake.prompts, ["next phase"]);
});

test("failures other than a busy session surface to the task run", async () => {
  const fake = fakePiSession(false, async () => {
    throw new Error("Model not found: missing-provider/missing-model");
  });
  await assert.rejects(promptIdlePiSession(fake.handle, "next phase"), /Model not found/);
  assert.deepEqual(fake.prompts, []);
});

test("the task runner routes its phase prompt through the idle wait", async () => {
  const source = await readFile("src/server.ts", "utf8");
  assert.match(source, /promptIdlePiSession\(shared\.handle, prompt\)/);
});
