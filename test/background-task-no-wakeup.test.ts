import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { supervisorRequest } from "../scripts/supervisor-client.mjs";
import { api, projectNamed, signIn } from "./dev-nodes.js";
import { backgroundFixture, closeBackgroundFixture, startSyntheticTask } from "./background-tasks-fixture.js";

async function waitFor<T>(read: () => T | Promise<T>, ready: (value: T) => boolean, label: string, attempts = 200): Promise<T> {
  let value!: T;
  for (let attempt = 0; attempt < attempts; attempt++) {
    value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for ${label}: ${JSON.stringify(value)}`);
}

function queuedPromptCount(dataDir: string): number {
  const db = new DatabaseSync(path.join(dataDir, "node.db"), { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='queued_prompts'").get()) return 0;
    return Number((db.prepare("SELECT COUNT(*) AS n FROM queued_prompts").get() as { n: number }).n);
  } finally { db.close(); }
}

test("a finished background task is visible in Tasks but never wakes its conversation", { timeout: 60_000 }, async () => {
  const f = await backgroundFixture((root) => ({ JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log") }));
  try {
    const session = await signIn(f.environment, f.node);
    const project = projectNamed(f.node, "Internal Assistant");
    // A real seeded conversation, so an accidental wake-up would have somewhere to land.
    const listed = await api<{ sessions: Array<{ id: string; harnessId: string }> }>(f.node, session, "GET", `/projects/${project.id}/sessions`);
    const target = listed.body.sessions.find((value) => value.harnessId === "pi")!;
    const records = new DatabaseSync(path.join(f.node.dataDir, "node.db"), { readOnly: true });
    let conversationId = target.id;
    try {
      const record = records.prepare("SELECT conversation_id FROM conversation_records WHERE project_id=? AND session_id=?").get(project.id, target.id) as { conversation_id: string | null } | undefined;
      if (record?.conversation_id) conversationId = record.conversation_id;
    } finally { records.close(); }
    const taskId = randomUUID();
    await startSyntheticTask(f, project.id, conversationId, taskId);
    await waitFor(async () => (await supervisorRequest<{ status: string }>(f.node.dataDir, { action: "task", id: taskId })).status, (status) => status === "completed", "supervisor task completion");

    // The old delivery poll ran every two seconds; give it several cycles to prove nothing fires.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    await assert.rejects(readFile(path.join(f.root, "engine.log")), /ENOENT/, "no model turn may start because a task finished");
    assert.equal(queuedPromptCount(f.node.dataDir), 0, "no conversation prompt may be queued for a finished task");

    const tasks = await api<{ tasks: Array<Record<string, unknown>> }>(f.node, session, "GET", `/background-tasks?projectId=${project.id}&conversationId=${conversationId}`);
    assert.equal(tasks.status, 200);
    const task = tasks.body.tasks.find((value) => value.id === taskId);
    assert.ok(task, "the finished task stays visible for inspection");
    assert.equal(task.status, "completed");
    assert.equal("completion" in task, false, "the task API no longer reports a follow-up delivery state");

    const removed = await fetch(`${f.node.url}/api/cluster/background-completions`, {
      method: "POST", headers: { Cookie: session.cookie, "x-csrf-token": session.csrfToken, "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(removed.status, 404, "the completion delivery route is gone");
  } finally {
    await closeBackgroundFixture(f);
  }
});
