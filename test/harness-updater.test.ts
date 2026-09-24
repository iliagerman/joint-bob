import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { HarnessAdapter } from "../src/harnesses/contract.js";
import { runHarnessUpdates } from "../src/harness-updater.js";

function adapter(id: string, executable: string, updateArgs?: string[]): HarnessAdapter {
  return {
    id, label: id, defaults: { provider: id, modelId: "model", thinkingLevel: "medium" },
    configuration: {
      defaults: () => ({ executable, configPath: os.tmpdir(), sessionPath: os.tmpdir() }),
      thinkingLevels: ["medium"], restartFields: [], ...(updateArgs ? { updateArgs } : {}),
    },
    paths: { newSession: `${id}:new`, ownsSession: () => false, ownsTranscript: () => false, sessionId: () => undefined },
    sync: { transcriptRoot: () => os.tmpdir() },
    sessions: { files: async () => [], list: async () => [], refresh: async () => [], loadMessages: async () => [] },
  } as HarnessAdapter;
}

test("harness updates run each adapter's instructions with its own executable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-update-"));
  const output = path.join(root, "calls.txt");
  const executable = path.join(root, "harness");
  await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${output}"\n`);
  await chmod(executable, 0o755);

  const result = await runHarnessUpdates([
    adapter("one", executable, ["update"]),
    adapter("two", executable, ["upgrade", "--yes"]),
    adapter("unsupported", executable),
  ]);

  assert.deepEqual(result.map(({ id, state }) => ({ id, state })), [
    { id: "one", state: "succeeded" },
    { id: "two", state: "succeeded" },
    { id: "unsupported", state: "unsupported" },
  ]);
  assert.equal(await readFile(output, "utf8"), "update\nupgrade --yes\n");
});

test("one failed harness update does not prevent later harnesses", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-update-failure-"));
  const failed = path.join(root, "failed");
  const succeeded = path.join(root, "succeeded");
  await writeFile(failed, "#!/bin/sh\necho broken >&2\nexit 7\n");
  await writeFile(succeeded, "#!/bin/sh\nexit 0\n");
  await chmod(failed, 0o755);
  await chmod(succeeded, 0o755);

  const result = await runHarnessUpdates([
    adapter("failed", failed, ["update"]),
    adapter("succeeded", succeeded, ["update"]),
  ]);

  assert.equal(result[0].state, "failed");
  assert.match(result[0].error ?? "", /broken/);
  assert.equal(result[1].state, "succeeded");
});
