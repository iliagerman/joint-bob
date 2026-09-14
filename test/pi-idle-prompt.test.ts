import assert from "node:assert/strict";
import test from "node:test";
import { PiSession } from "../src/harnesses/pi/runtime.js";
import { promptIdlePiSession, type PiSessionHandle } from "../src/pi-service.js";
import { serverSource } from "./source.js";

/** A Pi session double that reports busy state on demand and rejects prompts
    exactly the way the SDK does while a turn is running. */
function fakePiSession(startBusy: boolean, promptImpl?: (text: string) => Promise<void>) {
  const state = { streaming: startBusy };
  const listeners = new Set<(event: { type: string; messages?: unknown[] }) => void>();
  const prompts: string[] = [];
  const session = {
    sessionId: "fake-pi-session",
    messages: [] as unknown[],
    get isStreaming() { return state.streaming; },
    isBashRunning: false,
    isCompacting: false,
    isRetrying: false,
    subscribe(listener: (event: { type: string; messages?: unknown[] }) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    async prompt(text: string) {
      if (state.streaming) throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
      prompts.push(text);
      for (const listener of listeners) listener({ type: "agent_start" });
    },
    dispose() {},
  };
  if (promptImpl) (session as { prompt: (text: string) => Promise<void> }).prompt = promptImpl;
  return {
    handle: { session, safeguardsEnabled: true, dispose() {} } as unknown as PiSessionHandle,
    prompts,
    startTurn() { state.streaming = true; },
    endTurn() { state.streaming = false; for (const listener of listeners) listener({ type: "agent_end", messages: session.messages }); },
    emitWhileStreaming() { for (const listener of listeners) listener({ type: "agent_end", messages: session.messages }); },
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

test("Pi adapter waits for an initial busy session before its actual prompt attempt", async () => {
  const fake = fakePiSession(true);
  const session = new PiSession({ cwd: "/tmp", projectId: "project", sessionId: "fake-pi-session" }, fake.handle as never);
  let beforeStartCalls = 0;
  let startedCalls = 0;
  const outcome = session.prompt({
    text: "next phase",
    beforeStart: async () => { beforeStartCalls += 1; },
    onStarted: () => { startedCalls += 1; },
  }).then(() => undefined, (error: unknown) => error);

  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(fake.prompts, []);
    assert.equal(beforeStartCalls, 0, "caller fence ran before the Pi session became idle");
  } finally {
    fake.endTurn();
  }

  assert.equal(await outcome, undefined);
  assert.equal(beforeStartCalls, 1);
  assert.equal(startedCalls, 1);
  session.dispose();
});

test("Pi adapter retries an SDK busy race and checks the caller fence per attempt", async () => {
  let promptCalls = 0;
  const fake = fakePiSession(false, async (text) => {
    promptCalls += 1;
    if (promptCalls === 1) {
      fake.startTurn();
      throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
    }
    fake.prompts.push(text);
  });
  const session = new PiSession({ cwd: "/tmp", projectId: "project", sessionId: "fake-pi-session" }, fake.handle as never);
  let beforeStartCalls = 0;
  let startedCalls = 0;
  const outcome = session.prompt({
    text: "next phase",
    beforeStart: async () => { beforeStartCalls += 1; },
    onStarted: () => { startedCalls += 1; },
  }).then(() => undefined, (error: unknown) => error);

  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(beforeStartCalls, 1);
    assert.equal(promptCalls, 1);
  } finally {
    fake.endTurn();
  }

  assert.equal(await outcome, undefined);
  assert.equal(beforeStartCalls, 2);
  assert.equal(startedCalls, 1);
  assert.deepEqual(fake.prompts, ["next phase"]);
  session.dispose();
});

test("generic task dispatch uses HarnessSession.prompt and Pi keeps idle scheduling private", async () => {
  const source = await serverSource();
  assert.doesNotMatch(source, /promptIdlePiSession/);
  assert.match(source, /\.session\.prompt\(/);
  assert.match(PiSession.prototype.prompt.toString(), /service\.promptIdlePiSession\(this\.handle/);
});
