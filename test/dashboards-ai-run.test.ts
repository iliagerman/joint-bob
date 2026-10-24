import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";

/** A stand-in agent: answers with the reply the test puts in a file, and records what it was asked. */
async function fakeAgent(root: string): Promise<{ reply: (text: string) => Promise<void>; asked: () => Promise<Record<string, unknown>> }> {
  const replyFile = path.join(root, "reply.txt"), askedFile = path.join(root, "asked.json");
  const module = path.join(root, "agent.mjs");
  await writeFile(module, `import { readFile, writeFile } from "node:fs/promises";
export default async (input) => {
  await writeFile(${JSON.stringify(askedFile)}, JSON.stringify({ ...input, signal: undefined }));
  return readFile(${JSON.stringify(replyFile)}, "utf8");
};
`);
  process.env.JOINT_BOB_DASHBOARD_AGENT = module;
  return {
    reply: (text) => writeFile(replyFile, text),
    asked: async () => JSON.parse(await readFile(askedFile, "utf8")) as Record<string, unknown>,
  };
}

async function freshModules() {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-dashboard-ai-"));
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  const token = randomUUID();
  const files = await import(`../src/dashboards/files.js?ai=${token}`) as typeof import("../src/dashboards/files.js");
  const run = await import(`../src/dashboards/ai-run.js?ai=${token}`) as typeof import("../src/dashboards/ai-run.js");
  return { root, files, run, agent: await fakeAgent(root) };
}

const settings = { harnessId: "pi", provider: "openai", modelId: "gpt", thinkingLevel: "low" as const };

test("an AI refresh asks the dashboard agent for the payload and stores its JSON answer", async () => {
  const { root, files, run, agent } = await freshModules();
  const id = randomUUID();
  await agent.reply('```json\n{"generatedAt":"2026-10-24T09:00:00Z","bugs":7}\n```');
  const result = await run.runAiRefresh({ id, prompt: "Count today's bugs", projectId: "p1", cwd: root, settings });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(files.readPayload(id), { generatedAt: "2026-10-24T09:00:00Z", bugs: 7 });
  const asked = await agent.asked();
  assert.equal(asked.projectId, "p1");
  assert.equal(asked.cwd, root);
  assert.deepEqual(asked.settings, settings, "the node's dashboard agent settings choose the model");
  assert.match(String(asked.prompt), /Count today's bugs/);
  assert.match(String(asked.prompt), /ONLY the JSON/);
  assert.match(String(asked.prompt), new RegExp(files.stateDirectory(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the agent may keep state between refreshes");
});

test("an AI refresh that answers with prose fails and keeps the last payload", async () => {
  const { root, files, run, agent } = await freshModules();
  const id = randomUUID();
  files.writePayload(id, { generatedAt: "2026-10-23T09:00:00Z", bugs: 3 });
  await agent.reply("I could not reach the database today.");
  const result = await run.runAiRefresh({ id, prompt: "Count today's bugs", projectId: "p1", cwd: root, settings });
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /JSON/);
  assert.deepEqual(files.readPayload(id), { generatedAt: "2026-10-23T09:00:00Z", bugs: 3 });
  assert.match(files.readRunLog(id), /could not reach the database/, "the agent's answer is the run log");
});
