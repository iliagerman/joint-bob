import assert from "node:assert/strict";
import test from "node:test";
import { collectBobContext, notifyBobExchange, registerBobContextProvider, registerBobExchangeObserver, type BobTurn } from "../src/control-center/bob-hooks.js";
import { DEFAULT_BOB_SETTINGS } from "../src/control-center/bob-store.js";

const turn: BobTurn = { session: { accountId: "ilia" } as never, message: "hi", recentChat: [], project: null, options: [], settings: DEFAULT_BOB_SETTINGS };

test("every provider adds to what Bob knows, a failing one is skipped, and empty ones add nothing", async () => {
  registerBobContextProvider("test-memory", async () => ({ text: "Topic: release-gate. Push needs the token.", via: "Read memory: release-gate" }));
  registerBobContextProvider("test-broken", async () => { throw new Error("broken"); });
  registerBobContextProvider("test-empty", async () => ({ text: "   " }));
  registerBobContextProvider("test-null", async () => null);
  const found = await collectBobContext(turn);
  assert.equal(found.text, "Topic: release-gate. Push needs the token.");
  assert.deepEqual(found.via, ["Read memory: release-gate"]);
});

test("observers hear about a finished exchange without holding it up", async () => {
  const heard: string[] = [];
  registerBobExchangeObserver("test-learner", async (observed, reply) => { heard.push(`${observed.message} -> ${reply}`); });
  registerBobExchangeObserver("test-failing", async () => { throw new Error("nope"); });
  notifyBobExchange(turn, "hello");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(heard, ["hi -> hello"]);
});
