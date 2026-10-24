import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

/** A stand-in agent that reports a tool step and some text, writes the page first, waits, then finishes the draft. */
async function slowAgent(root: string): Promise<string> {
  const module = path.join(root, "dashboard-agent.mjs");
  await writeFile(module, `import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
export default async (input) => {
  const draft = /Draft folder \\(edit here\\): (.+)/.exec(input.prompt)[1].trim();
  await mkdir(draft, { recursive: true });
  input.onActivity({ tool: "bash", target: "psql -c 'select count(*) from errors'" });
  input.onText("Looking at the errors table");
  await writeFile(path.join(draft, "index.html"), "<script>JointBobKit.mount(JointBobKit.kpi({ label: 'Bugs', value: JointBobKit.payload().bugs ?? 0 }))</script>");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await writeFile(path.join(draft, "manifest.json"), JSON.stringify({ title: "Bugs", refresh: { method: "script", command: 'node "$JOINT_BOB_DASHBOARD_DIR/refresh.mjs"' } }));
  await writeFile(path.join(draft, "refresh.mjs"), "console.log(JSON.stringify({ generatedAt: new Date().toISOString(), bugs: 7 }))");
  return "Done: one number, refreshed by a script.";
};
`);
  return module;
}

type View = Record<string, any>;

test("while the agent works its steps, its text and the first page are visible, and the finished draft is test-refreshed", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-dashboards-activity-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    server = await startDevNode(environment, node, { JOINT_BOB_DASHBOARD_AGENT: await slowAgent(root) });
    const auth = await signIn(environment, node);
    const projectId = node.projects[0].id;
    const created = await api<View>(node, auth, "POST", "/dashboards", { entity: { kind: "project", id: projectId }, projectId });
    const id = created.body.dashboard.id;
    assert.equal((await api(node, auth, "POST", `/dashboards/${id}/messages`, { text: "Count bugs", projectId })).status, 202);

    let during: View | undefined;
    for (let attempt = 0; attempt < 100 && !during; attempt += 1) {
      const view = await api<View>(node, auth, "GET", `/dashboards/${id}?projectId=${projectId}`);
      if (view.body.dashboard.draftHasPage && view.body.dashboard.running) during = view.body;
      else await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(during, "the page shows up while the agent is still working");
    assert.equal(during.dashboard.running.kind, "creator");
    assert.deepEqual(during.dashboard.running.activity.map(({ tool, target }: View) => ({ tool, target })), [{ tool: "bash", target: "psql -c 'select count(*) from errors'" }]);
    assert.equal(during.dashboard.running.text, "Looking at the errors table");
    assert.equal(typeof during.dashboard.draftVersion, "number");
    assert.equal(during.dashboard.draftCheck.ok, false, "the draft is not complete yet");

    let after: View | undefined;
    for (let attempt = 0; attempt < 200 && !after; attempt += 1) {
      const view = await api<View>(node, auth, "GET", `/dashboards/${id}?projectId=${projectId}`);
      if (!view.body.dashboard.running) after = view.body;
      else await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(after);
    assert.equal(after.dashboard.draftRefresh?.ok, true, "a finished script draft is test-refreshed without being asked");
    const frame = await (await fetch(`${node.url}/api/dashboards/${id}/frame?draft=1&projectId=${projectId}`, { headers: { cookie: auth.cookie } })).text();
    assert.match(frame, /"bugs":7/);
    assert.match(after.messages.at(-1).text, /Done: one number/);
  } finally {
    if (server) await stopDevNode(server);
  }
});
