import { appendFile } from "node:fs/promises";
import type { HarnessSession } from "../src/harnesses/runtime.js";
import { installStubHarnessRuntimes } from "./stub-harness-runtime.js";

if (process.env.NODE_ENV !== "test" || !process.env.JOINT_BOB_TEST_ENGINE_LOG || !process.env.JOINT_BOB_TEST_FAILURE_LOG) {
  throw new Error("Background start failure bootstrap requires test engine and failure logs");
}

await installStubHarnessRuntimes();
const { getHarnessRuntime } = await import("../src/harnesses.js");
const runtime = await getHarnessRuntime("pi");
const open = runtime.open.bind(runtime);
runtime.open = async (options): Promise<HarnessSession> => {
  const session = await open(options);
  session.prompt = async (input) => {
    await input.beforeStart?.();
    await appendFile(process.env.JOINT_BOB_TEST_FAILURE_LOG!, `${JSON.stringify({ sessionId: options.sessionId, text: input.text })}\n`);
    throw new Error("Synthetic uncertain start before acknowledgement");
  };
  return session;
};
