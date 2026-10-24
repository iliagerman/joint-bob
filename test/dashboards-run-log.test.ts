import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("a failed refresh shows what the script wrote to stderr", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-dashboards-run-log-"));
  const module = path.join(root, "agent.mjs");
  await writeFile(module, `import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
export default async (input) => {
  const draft = /Draft folder \\(edit here\\): (.+)/.exec(input.prompt)[1].trim();
  await mkdir(draft, { recursive: true });
  await writeFile(path.join(draft, "manifest.json"), JSON.stringify({ title: "Broken", refresh: { method: "script", command: "echo 'ECONNREFUSED 10.0.0.5:5432' >&2; exit 1" } }));
  await writeFile(path.join(draft, "index.html"), "<p>x</p>");
  return "done";
};
`);
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    server = await startDevNode(environment, node, { JOINT_BOB_DASHBOARD_AGENT: module });
    const auth = await signIn(environment, node);
    const projectId = node.projects[0].id;
    const created = await api<Record<string, any>>(node, auth, "POST", "/dashboards", { entity: { kind: "project", id: projectId }, projectId });
    const id = created.body.dashboard.id;
    await api(node, auth, "POST", `/dashboards/${id}/messages`, { text: "build it", projectId });
    const wait = async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const view = await api<Record<string, any>>(node, auth, "GET", `/dashboards/${id}?projectId=${projectId}`);
        if (!view.body.dashboard.running) return view.body;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("still running");
    };
    await wait();
    assert.equal((await api(node, auth, "POST", `/dashboards/${id}/draft/save`, { projectId })).status, 200);
    await api(node, auth, "POST", `/dashboards/${id}/refresh`, { target: "live", projectId });
    const view = await wait();
    assert.equal(view.dashboard.lastRefresh.ok, false);
    assert.match(view.runLog, /ECONNREFUSED 10\.0\.0\.5:5432/, "the reason a refresh failed is shown, not only its exit code");
  } finally {
    if (server) await stopDevNode(server);
  }
});
