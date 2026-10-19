import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("pairing twins does not automatically share saved commands", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "commands-twins-"));
  const env = await seedDevEnvironment(root, 2), [a, b] = env.nodes;
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    children.push(await startDevNode(env, a), await startDevNode(env, b));
    const sa = await signIn(env, a), sb = await signIn(env, b);
    const settings = (await api<any>(a, sa, "GET", "/settings")).body;
    await api(a, sa, "PUT", "/settings/personal", { conversationCommands: { ...settings.conversationCommands, presets: [{ name: "Private", prompt: "Never auto-share" }] } });
    await pairTwinNodes(env);
    const local = await api<any>(a, sa, "GET", `/commands?projectId=${a.projects[0].id}`);
    assert.equal(local.body.commands.length, 1);
    const remote = await api<any>(b, sb, "POST", "/commands/refresh", {});
    assert.equal(remote.status, 200);
    assert.equal(remote.body.commands.some((c: any) => c.prompt === "Never auto-share"), false, "twin trust alone grants no commands");
  } finally { await Promise.all(children.map(stopDevNode)); await rm(root, { recursive: true, force: true }); }
});
