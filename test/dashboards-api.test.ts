import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SignedIn } from "./dev-nodes.js";

/** A stand-in dashboard agent: on a creator turn it writes a script dashboard into the draft folder;
    on an AI refresh it answers with JSON. It records every prompt it is given. */
async function writeFakeAgent(root: string): Promise<{ module: string; prompts: string }> {
  const module = path.join(root, "dashboard-agent.mjs"), prompts = path.join(root, "prompts.jsonl");
  await writeFile(module, `import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
export default async (input) => {
  await appendFile(${JSON.stringify(prompts)}, JSON.stringify({ prompt: input.prompt, cwd: input.cwd, projectId: input.projectId, settings: input.settings }) + "\\n");
  if (input.prompt.startsWith("You are refreshing")) return JSON.stringify({ generatedAt: new Date().toISOString(), bugs: 42, source: "ai" });
  // Slow enough that a second request arrives while this turn is still running.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const draft = /Draft folder \\(edit here\\): (.+)/.exec(input.prompt)[1].trim();
  await mkdir(draft, { recursive: true });
  const ai = input.prompt.includes("refresh with AI");
  await writeFile(path.join(draft, "manifest.json"), JSON.stringify({ title: "Bugs", refresh: ai ? { method: "ai", prompt: "Count bugs" } : { method: "script", command: 'node "$JOINT_BOB_DASHBOARD_DIR/refresh.mjs"' } }));
  await writeFile(path.join(draft, "refresh.mjs"), "console.log(JSON.stringify({ generatedAt: new Date().toISOString(), bugs: 7, cwd: process.cwd(), state: process.env.JOINT_BOB_DASHBOARD_STATE }))");
  await writeFile(path.join(draft, "index.html"), "<script>const data = JointBobKit.payload(); JointBobKit.mount(JointBobKit.kpi({ label: 'Bugs', value: data.bugs }))</script>");
  return "I built a dashboard with the number of bugs.";
};
`);
  return { module, prompts };
}

type View = Record<string, any>;

async function settled(node: Parameters<typeof api>[0], auth: SignedIn, id: string, projectId: string): Promise<View> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const view = await api<View>(node, auth, "GET", `/dashboards/${id}?projectId=${encodeURIComponent(projectId)}`);
    assert.equal(view.status, 200, JSON.stringify(view.body));
    if (!view.body.dashboard.running) return view.body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The dashboard run did not finish");
}

test("a project dashboard is created by the agent, saved, and refreshed by its script", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-dashboards-api-"));
  const agent = await writeFakeAgent(root);
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    server = await startDevNode(environment, node, { JOINT_BOB_DASHBOARD_AGENT: agent.module });
    const auth = await signIn(environment, node);
    const project = node.projects[0];
    const entity = { kind: "project", id: project.id };

    const empty = await api<View>(node, auth, "GET", `/dashboards?kind=project&id=${project.id}&projectId=${project.id}`);
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.deepEqual(empty.body.dashboards, []);
    assert.equal(empty.body.displayedId, null);
    assert.equal(empty.body.label, project.name);

    const created = await api<View>(node, auth, "POST", "/dashboards", { entity, projectId: project.id });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = created.body.dashboard.id as string;
    assert.equal(created.body.dashboard.saved, false);

    const started = await api<View>(node, auth, "POST", `/dashboards/${id}/messages`, { text: "Show the number of bugs", projectId: project.id });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const busy = await api<View>(node, auth, "POST", `/dashboards/${id}/messages`, { text: "again", projectId: project.id });
    assert.equal(busy.status, 409, "one creator turn at a time");
    let view = await settled(node, auth, id, project.id);
    assert.deepEqual(view.messages.map((message: View) => message.role), ["user", "assistant"]);
    assert.match(view.messages[1].text, /built a dashboard/);
    assert.equal(view.dashboard.hasDraft, true);
    assert.deepEqual(view.dashboard.draftCheck, { ok: true });

    const prompt = (await import("node:fs/promises")).readFile(agent.prompts, "utf8").then((text) => JSON.parse(text.trim().split("\n")[0]));
    const asked = await prompt;
    assert.equal(asked.projectId, project.id);
    assert.equal(asked.cwd, project.path);
    assert.match(asked.prompt, /project dashboard/);
    assert.match(asked.prompt, /Show the number of bugs/);
    assert.equal(asked.settings.harnessId, "pi", "the node's dashboard agent settings choose the agent");

    await api(node, auth, "POST", `/dashboards/${id}/refresh`, { target: "draft", projectId: project.id });
    view = await settled(node, auth, id, project.id);
    assert.equal(view.dashboard.draftRefresh.ok, true, JSON.stringify(view.dashboard.draftRefresh));
    const draftFrame = await fetch(`${node.url}/api/dashboards/${id}/frame?draft=1&projectId=${project.id}`, { headers: { cookie: auth.cookie } });
    assert.equal(draftFrame.status, 200);
    assert.match(draftFrame.headers.get("content-security-policy")!, /default-src 'none'/);
    assert.match(await draftFrame.text(), /"bugs":7/);

    const saved = await api<View>(node, auth, "POST", `/dashboards/${id}/draft/save`, { projectId: project.id });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.dashboard.saved, true);
    assert.equal(saved.body.dashboard.active, true);
    assert.equal(saved.body.dashboard.hasDraft, false);
    assert.equal(saved.body.dashboard.refreshMethod, "script");

    const before = await (await fetch(`${node.url}/api/dashboards/${id}/frame?projectId=${project.id}`, { headers: { cookie: auth.cookie } })).text();
    assert.doesNotMatch(before, /"bugs":7/, "the draft's test data never becomes the live data");
    await api(node, auth, "POST", `/dashboards/${id}/refresh`, { target: "live", projectId: project.id });
    view = await settled(node, auth, id, project.id);
    assert.equal(view.dashboard.lastRefresh.ok, true, JSON.stringify(view.dashboard.lastRefresh));
    const live = await (await fetch(`${node.url}/api/dashboards/${id}/frame?projectId=${project.id}`, { headers: { cookie: auth.cookie } })).text();
    const payload = JSON.parse(/id="payload">([^]*?)<\/script>/.exec(live)![1]);
    assert.equal(payload.bugs, 7);
    assert.equal((await import("node:fs")).realpathSync(payload.cwd), (await import("node:fs")).realpathSync(project.path), "scripts run in the project folder");

    assert.equal(view.runLog, "", "a clean run leaves an empty log");

    const definition = await api<View>(node, auth, "GET", `/dashboards/${id}/definition?projectId=${project.id}`);
    assert.deepEqual(definition.body.files.map((file: View) => file.path), ["index.html", "manifest.json", "refresh.mjs"]);
    assert.match(definition.body.files[2].text, /console\.log/, "the script can be read before it is approved");

    const listed = await api<View>(node, auth, "GET", `/dashboards?kind=project&id=${project.id}&projectId=${project.id}`);
    assert.equal(listed.body.displayedId, id);

    await api(node, auth, "POST", `/dashboards/${id}/messages`, { text: "Change it, refresh with AI", projectId: project.id });
    await settled(node, auth, id, project.id);
    const discarded = await api<View>(node, auth, "POST", `/dashboards/${id}/draft/discard`, { projectId: project.id });
    assert.equal(discarded.body.dashboard.hasDraft, false);
    assert.equal(discarded.body.dashboard.refreshMethod, "script", "discarding keeps the saved dashboard");

    const removed = await api(node, auth, "DELETE", `/dashboards/${id}?projectId=${project.id}`);
    assert.equal(removed.status, 200);
    assert.equal((await api(node, auth, "GET", `/dashboards/${id}?projectId=${project.id}`)).status, 404);
  } finally {
    if (server) await stopDevNode(server);
  }
});

test("conversation and workspace dashboards check their entity, and AI refreshes use the agent", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-dashboards-entities-"));
  const agent = await writeFakeAgent(root);
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    server = await startDevNode(environment, node, { JOINT_BOB_DASHBOARD_AGENT: agent.module });
    const auth = await signIn(environment, node);
    const project = node.projects[0];
    const sessions = await api<{ sessions: Array<Record<string, string>> }>(node, auth, "GET", `/projects/${project.id}/sessions`);
    const conversationId = sessions.body.sessions[0].conversationId ?? sessions.body.sessions[0].id;

    const missing = await api(node, auth, "POST", "/dashboards", { entity: { kind: "conversation", id: "no-such-conversation", projectId: project.id }, projectId: project.id });
    assert.equal(missing.status, 404);
    const conversation = await api<View>(node, auth, "POST", "/dashboards", { entity: { kind: "conversation", id: conversationId, projectId: project.id }, projectId: project.id });
    assert.equal(conversation.status, 200, JSON.stringify(conversation.body));
    const id = conversation.body.dashboard.id;
    await api(node, auth, "POST", `/dashboards/${id}/messages`, { text: "Track this conversation, refresh with AI", projectId: project.id });
    await settled(node, auth, id, project.id);
    const asked = (await (await import("node:fs/promises")).readFile(agent.prompts, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.match(asked[0].prompt, /conversation dashboard/);
    assert.match(asked[0].prompt, /Transcript:/, "the creator can read the conversation");
    const saved = await api<View>(node, auth, "POST", `/dashboards/${id}/draft/save`, { projectId: project.id });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const started = await api<View>(node, auth, "POST", `/dashboards/${id}/refresh`, { target: "live", projectId: project.id });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const refreshed = await settled(node, auth, id, project.id);
    assert.equal(refreshed.dashboard.refreshMethod, "ai");
    assert.equal(refreshed.dashboard.lastRefresh?.ok, true, JSON.stringify(refreshed.dashboard));

    const projects = await api<{ projects: Array<Record<string, string>> }>(node, auth, "GET", "/projects");
    const host = projects.body.projects.find((candidate) => candidate.id === project.id)!;
    const workspaceId = host.type;
    const other = projects.body.projects.find((candidate) => candidate.type !== workspaceId);
    const wrongHost = other ? await api(node, auth, "POST", "/dashboards", { entity: { kind: "workspace", id: workspaceId }, hostProjectId: other.id, projectId: other.id }) : undefined;
    if (wrongHost) assert.equal(wrongHost.status, 404, "a workspace dashboard runs in one of its own projects");
    const workspace = await api<View>(node, auth, "POST", "/dashboards", { entity: { kind: "workspace", id: workspaceId }, hostProjectId: project.id, projectId: project.id });
    assert.equal(workspace.status, 200, JSON.stringify(workspace.body));
    const listing = await api<View>(node, auth, "GET", `/dashboards?kind=workspace&id=${workspaceId}&projectId=${project.id}`);
    assert.ok(listing.body.workspaceProjects.some((candidate: View) => candidate.id === project.id), "the workspace lists projects to run in");
  } finally {
    if (server) await stopDevNode(server);
  }
});
