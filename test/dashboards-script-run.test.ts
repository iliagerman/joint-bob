import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";

async function freshModules() {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-dashboard-script-"));
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  const token = randomUUID();
  const files = await import(`../src/dashboards/files.js?run=${token}`) as typeof import("../src/dashboards/files.js");
  const run = await import(`../src/dashboards/script-run.js?run=${token}`) as typeof import("../src/dashboards/script-run.js");
  return { root, files, run };
}

function input(root: string, command: string, extra: Partial<{ timeoutMs: number; env: NodeJS.ProcessEnv }> = {}) {
  return { id: randomUUID(), command, cwd: root, definitionDirectory: root, env: { PATH: process.env.PATH, ...extra.env }, ...(extra.timeoutMs ? { timeoutMs: extra.timeoutMs } : {}) };
}

test("a script that prints a JSON object becomes the payload, with its state folder and secrets in the environment", async () => {
  const { root, files, run } = await freshModules();
  const job = input(root, `printf '{"generatedAt":"2026-10-24T09:00:00Z","state":"%s","dir":"%s","secret":"%s","cwd":"%s"}' "$JOINT_BOB_DASHBOARD_STATE" "$JOINT_BOB_DASHBOARD_DIR" "$API_TOKEN" "$PWD"`, { env: { API_TOKEN: "t0ken" } });
  const result = await run.runScriptRefresh(job);
  assert.equal(result.ok, true, JSON.stringify(result));
  const payload = files.readPayload(job.id) as Record<string, string>;
  assert.equal(payload.state, files.stateDirectory(job.id));
  assert.equal(payload.dir, root);
  assert.equal(payload.secret, "t0ken");
  assert.equal(realpathSync(payload.cwd), realpathSync(root));
});

test("the previous payload is offered to the next run and kept when a run prints something else", async () => {
  const { root, files, run } = await freshModules();
  const job = input(root, `printf '{"generatedAt":"2026-10-24T09:00:00Z","n":1}'`);
  assert.equal((await run.runScriptRefresh(job)).ok, true);
  const second = await run.runScriptRefresh({ ...job, command: `cat "$JOINT_BOB_DASHBOARD_PREVIOUS" >&2; printf 'not json'` });
  assert.equal(second.ok, false);
  assert.match((second as { error: string }).error, /JSON/);
  assert.deepEqual(files.readPayload(job.id), { generatedAt: "2026-10-24T09:00:00Z", n: 1 }, "a failed run keeps the last good payload");
  assert.match(files.readRunLog(job.id), /"n":1/, "stderr goes to the run log");
});

test("a failing exit, a hang and an oversized output each fail the run", async () => {
  const { root, run } = await freshModules();
  const exit = await run.runScriptRefresh(input(root, "echo broken >&2; exit 3"));
  assert.deepEqual(exit, { ok: false, error: "The refresh script exited with code 3" });
  const started = Date.now();
  const hang = await run.runScriptRefresh(input(root, "sleep 30", { timeoutMs: 300 }));
  assert.deepEqual(hang, { ok: false, error: "The refresh script did not finish within 1 s and was stopped" });
  assert.ok(Date.now() - started < 10_000, "the hung script is killed, not waited for");
  const big = await run.runScriptRefresh(input(root, `head -c ${5 * 1024 * 1024} /dev/zero`));
  assert.deepEqual(big, { ok: false, error: "The refresh script printed more than 4 MiB" });
});
