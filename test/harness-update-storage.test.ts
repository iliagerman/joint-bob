import assert from "node:assert/strict";
import test from "node:test";
import { listPendingUpdateRecoveries, saveUpdateRecoveries, type UpdateRecoveryRecord } from "../src/update-recovery.js";

function record(id: string, settings?: UpdateRecoveryRecord["settings"]): UpdateRecoveryRecord {
  return {
    id, kind: "chat", engine: "kiro", projectId: "project", cwd: "/tmp/project",
    sessionId: `session-${id}`, sessionPath: `kiro:/tmp/${id}.jsonl`, taskId: null, phase: null,
    queuedPrompts: [], model: "kiro-model", effort: "high", ...(settings ? { settings } : {}),
    createdAt: `2026-01-01T00:00:0${id}.000Z`,
  };
}

test("update recovery retains generic harness settings and omits settings for legacy records", async () => {
  const settings = { provider: "kiro", modelId: "kiro-model", reasoning: "high", enabledTools: ["read", "write"] };
  await saveUpdateRecoveries([record("1", settings), record("2")]);
  const recovered = await listPendingUpdateRecoveries();
  assert.deepEqual(recovered[0].settings, settings);
  assert.equal(recovered[0].model, "kiro-model");
  assert.equal(recovered[0].effort, "high");
  assert.equal(Object.hasOwn(recovered[1], "settings"), false);
});
