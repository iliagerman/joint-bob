import assert from "node:assert/strict";
import test from "node:test";
import { queuedSettingsSchema } from "../src/prompt-queue.js";

test("saved conversation settings retain Claude tool restrictions for a fork", () => {
  const settings = { provider: "claude", modelId: "sonnet", reasoning: "high", claudeTools: { available: ["Read", "Bash"], enabled: ["Read"] } };
  assert.deepEqual(queuedSettingsSchema.parse(settings), settings);
});
