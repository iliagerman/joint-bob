import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, projectNamed, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode, type SignedIn } from "./dev-nodes.js";

/**
 * A stand-in dashboard agent. A creator turn writes a one-number dashboard whose title is the request's
 * "Title: ..." line (default "Bugs"); a request that says "refresh with AI" makes it an AI dashboard. A request
 * containing "stuck" makes it fail. An AI refresh answers with JSON.
 */
const FAKE_AGENT = `import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
export default async (input) => {
  if (input.prompt.startsWith("You are refreshing")) return JSON.stringify({ generatedAt: new Date().toISOString(), bugs: 99, source: "ai" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const request = input.prompt.split("## The person's request")[1] ?? "";
  if (request.includes("stuck")) throw new Error("the model is not answering");
  const draft = /Draft folder \\(edit here\\): (.+)/.exec(input.prompt)[1].trim();
  await mkdir(draft, { recursive: true });
  const title = /Title: ([^\\n]+)/.exec(request)?.[1] ?? "Bugs";
  const ai = request.includes("refresh with AI");
  await writeFile(path.join(draft, "manifest.json"), JSON.stringify({ title, refresh: ai ? { method: "ai", prompt: "Count bugs" } : { method: "script", command: 'node "$JOINT_BOB_DASHBOARD_DIR/refresh.mjs"' } }));
  await writeFile(path.join(draft, "refresh.mjs"), "console.log(JSON.stringify({ generatedAt: new Date().toISOString(), bugs: 7 }))");
  await writeFile(path.join(draft, "index.html"), "<script>const data = JointBobKit.payload(); JointBobKit.mount(JointBobKit.kpi({ label: 'Bugs', value: data.bugs ?? 0 }))</script>");
  return "I built the dashboard.";
};
`;

/**
 * A stand-in decision model, asked the way the real one is. The message decides: "Joint Bob" is a project, "for me"
 * is a dashboard for the person, "dashboard" with "Joint Bob" or "bugs per day" is a project dashboard.
 */
async function decisionModel(): Promise<{ server: Server; url: string; requests: Array<{ questions: string[]; message: string }> }> {
  const requests: Array<{ questions: string[]; message: string }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { state: string; questions: Record<string, { criteria: Record<string, string> }> };
      const message = (JSON.parse(parsed.state) as { user_message: string }).user_message;
      requests.push({ questions: Object.keys(parsed.questions), message });
      const choose = (choice: string) => ({ type: "choice", choice, confidence: 0.97 });
      const answers: Record<string, unknown> = {};
      for (const [id, question] of Object.entries(parsed.questions)) {
        if (id === "kind") answers[id] = choose("task");
        else if (id === "size") answers[id] = choose("long");
        else if (id === "project") answers[id] = choose(Object.entries(question.criteria).find(([key, text]) => key !== "none" && message.includes(text.split(".")[0]))?.[0] ?? "none");
        else if (id === "dashboard_project") answers[id] = choose(message.includes("dashboard") && (message.includes("Joint Bob") || message.includes("bugs per day")) ? "yes" : "no");
        else if (id === "dashboard_me") answers[id] = choose(message.includes("for me") ? "yes" : "no");
        // Whatever else Bob asks in the same request (other features add questions) gets its first option.
        else answers[id] = choose(Object.keys(question.criteria)[0]);
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ answers }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/systemone`, requests };
}

interface Message { id: string; role: string; text: string; via: string | null; importance: string; projectId: string | null; projectName: string | null; actions: Array<{ id: string; label: string }> }
interface Card { id: string; title: string; group: string; madeBy: string; status: string; refreshMethod: string | null; approved: boolean; projectId: string | null; projectName: string | null; workspaceLabel: string | null; changing: boolean; canChange: boolean; lastRefresh: { ok: boolean } | null; entity: { kind: string; id: string } }

async function eventually<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Never happened: ${label}`);
}

test("Bob builds dashboards from chat, the tab lists them, and Ask Bob changes one", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-control-dashboards-"));
  const classifier = await decisionModel();
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const agent = path.join(root, "dashboard-agent.mjs");
    await writeFile(agent, FAKE_AGENT);
    const environment = await seedDevEnvironment(root, 1);
    const node: SeededNode = environment.nodes[0];
    server = await startDevNode(environment, node, { JOINT_BOB_DASHBOARD_AGENT: agent, JOINT_BOB_TYPESAFE_ENDPOINT: classifier.url });
    const auth: SignedIn = await signIn(environment, node);
    const project = projectNamed(node, "Joint Bob");
    // The decision model's key comes from a secret account attached to a project.
    const account = await api<{ account: { id: string } }>(node, auth, "POST", "/secrets/accounts", { label: "decision", provider: "custom", variables: [{ name: "TYPESAFE_AI_API_KEY", kind: "value", value: "test-key" }] });
    assert.equal((await api(node, auth, "PUT", `/secrets/scopes/project/${project.id}`, { accountIds: [account.body.account.id] })).status, 200);

    const cards = async () => (await api<{ dashboards: Card[] }>(node, auth, "GET", "/control-center/dashboards")).body.dashboards;
    const timeline = async () => (await api<{ messages: Message[] }>(node, auth, "GET", "/control-center/bob/messages")).body.messages;
    const send = (message: string, projectId?: string) => api<{ action: string; user: Message; reply: Message }>(node, auth, "POST", "/control-center/bob/message", { message, ...(projectId ? { projectId } : {}) });

    assert.deepEqual(await cards(), [], "nothing yet");
    assert.equal((await api(node, auth, "GET", "/control-center/dashboards?x=1")).status, 400, "the list takes no query");

    // 1. One message asks for a project's dashboard and one for the person. Bob starts both and answers at once.
    const asked = await send("build a dashboard of bugs per day for Joint Bob, and one for me with what needs my attention\nTitle: Start here");
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.equal(asked.body.action, "answer");
    assert.equal(asked.body.reply.importance, "fyi", asked.body.reply.text);
    assert.match(asked.body.reply.text, /Building the dashboard for "Joint Bob" and your own dashboard \(workspace "[^"]+"\)/);
    assert.match(asked.body.reply.text, /I will tell you here when they are done/);
    assert.match(asked.body.reply.via ?? "", /^Dashboards · decision model 97%/);
    assert.equal(classifier.requests.filter((request) => request.questions.includes("dashboard_project")).length, 1, "one request answers both dashboard questions");
    assert.deepEqual(classifier.requests.find((request) => request.questions.includes("dashboard_me"))?.questions.sort(), ["dashboard_me", "dashboard_project"]);

    // While the agents work the tab lists what Bob is building.
    const building = await cards();
    assert.equal(building.length, 2);
    assert.ok(building.every((card) => card.status === "building" && card.madeBy === "bob" && card.title === "New dashboard"), JSON.stringify(building));
    assert.equal((await api(node, auth, "POST", `/control-center/dashboards/${building[0].id}/ask-bob`, { text: "more" })).status, 409, "a dashboard cannot be changed before it is saved");

    // 2. When each is done, Bob says so with a button to the Dashboards tab; the dashboard is saved, active and refreshed.
    const done = await eventually(async () => {
      const messages = (await timeline()).filter((message) => message.importance === "done");
      return messages.length === 2 ? messages : undefined;
    }, "both dashboards reported done");
    for (const message of done) {
      assert.equal(message.role, "bob");
      assert.match(message.text, /Done\. "Start here" is ready for/);
      assert.match(message.text, /refreshes by script, so refreshing it costs no AI\. It shows current data\./);
      assert.equal(message.via, "Dashboards · script refresh, no AI");
      assert.deepEqual(message.actions.map((action) => [action.id, action.label]), [["dashboards.open", "Open dashboards"]]);
    }
    assert.deepEqual(done.map((message) => message.projectId).sort(), [null, project.id].sort(), "the project's is labelled with it; the personal one is general");
    const listed = await cards();
    assert.deepEqual(listed.map((card) => [card.group, card.madeBy, card.status, card.refreshMethod, card.approved, card.lastRefresh?.ok]).sort(), [
      ["me", "bob", "ready", "script", true, true], ["project", "bob", "ready", "script", true, true],
    ]);
    const mine = listed.find((card) => card.group === "me")!;
    const projectCard = listed.find((card) => card.group === "project")!;
    assert.equal(projectCard.projectName, "Joint Bob");
    assert.equal(projectCard.projectId, project.id);
    assert.ok(mine.workspaceLabel, "a personal dashboard belongs to a workspace");
    // The existing dashboard view shows the very same dashboard, with the data its refresh printed.
    const detail = await api<{ dashboard: { saved: boolean; active: boolean; refreshMethod: string } }>(node, auth, "GET", `/dashboards/${projectCard.id}?projectId=${project.id}`);
    assert.deepEqual({ saved: detail.body.dashboard.saved, active: detail.body.dashboard.active, method: detail.body.dashboard.refreshMethod }, { saved: true, active: true, method: "script" });
    const frame = await fetch(`${node.url}/api/dashboards/${projectCard.id}/frame?projectId=${project.id}`, { headers: { Cookie: auth.cookie } });
    assert.match(await frame.text(), /"bugs":7/);

    // 3. A dashboard that refreshes with AI says so, and Bob does not spend AI on a first refresh.
    const ai = await send("make a dashboard for Joint Bob with a refresh with AI\nTitle: Judged", project.id);
    assert.equal(ai.status, 200, JSON.stringify(ai.body));
    const aiDone = await eventually(async () => (await timeline()).find((message) => message.text.includes('"Judged"')), "the AI dashboard reported");
    assert.match(aiDone.text, /It refreshes with AI: each refresh runs the dashboard agent and uses AI, so I have not run one\./);
    assert.equal(aiDone.via, "Dashboards · AI refresh");
    const aiCard = (await cards()).find((card) => card.title === "Judged")!;
    assert.deepEqual([aiCard.refreshMethod, aiCard.lastRefresh, aiCard.status], ["ai", null, "ready"]);
    const replaced = (await cards()).filter((card) => card.group === "project");
    assert.deepEqual(replaced.map((card) => card.title), ["Judged"], "the newest dashboard Bob made is the one the project shows");

    // 4. A change asked from the dashboard goes through the same agent, in Bob's chat.
    assert.equal((await api(node, auth, "POST", `/control-center/dashboards/${aiCard.id}/ask-bob`, { text: "" })).status, 400);
    assert.equal((await api(node, auth, "POST", `/control-center/dashboards/${aiCard.id}/ask-bob`, { text: "x", extra: 1 })).status, 400);
    assert.equal((await api(node, auth, "POST", "/control-center/dashboards/not-an-id/ask-bob", { text: "x" })).status, 400);
    assert.equal((await api(node, auth, "POST", "/control-center/dashboards/6f1c1d6e-0b0a-4c43-9f3a-111111111111/ask-bob", { text: "x" })).status, 404);
    const changed = await api<{ user: Message; reply: Message }>(node, auth, "POST", `/control-center/dashboards/${aiCard.id}/ask-bob`, { text: "rename it, and keep it a refresh with AI\nTitle: Judged weekly" });
    assert.equal(changed.status, 202, JSON.stringify(changed.body));
    assert.match(changed.body.user.text, /^Change the dashboard "Judged": rename it/);
    assert.equal(changed.body.user.role, "user");
    assert.match(changed.body.reply.text, /Changing "Judged"\./);
    assert.equal((await cards()).find((card) => card.id === aiCard.id)!.changing, true);
    assert.equal((await api(node, auth, "POST", `/control-center/dashboards/${aiCard.id}/ask-bob`, { text: "again" })).status, 409, "one job at a time");
    const changeDone = await eventually(async () => (await timeline()).find((message) => message.text.includes('I changed "Judged weekly"')), "the change reported");
    assert.equal(changeDone.importance, "done");
    assert.match(changeDone.text, /It refreshes with AI: each refresh runs the dashboard agent and uses AI/);
    const after = (await cards()).find((card) => card.id === aiCard.id)!;
    assert.deepEqual([after.title, after.changing, after.madeBy], ["Judged weekly", false, "bob"]);

    // 5. An agent that cannot finish leaves a draft and Bob says so; the card says it was never finished.
    const failed = await send("make a dashboard for Joint Bob that is stuck", project.id);
    assert.equal(failed.status, 200);
    const failure = await eventually(async () => (await timeline()).find((message) => message.importance === "needs-you" && message.text.includes("I could not finish")), "the failure reported");
    assert.match(failure.text, /The dashboard agent stopped: the model is not answering/);
    assert.match(failure.text, /stays as a draft/);
    assert.deepEqual(failure.actions.map((action) => action.id), ["dashboards.open"]);
    const draft = (await cards()).find((card) => card.status === "draft")!;
    assert.deepEqual([draft.title, draft.madeBy, draft.canChange], ["New dashboard", "bob", false]);
    assert.equal((await cards()).find((card) => card.group === "project" && card.status === "ready")!.title, "Judged weekly", "the project still shows its working dashboard");

    // 6. Without a project in the message or the chat's project box, Bob asks and builds nothing.
    const before = (await cards()).length;
    const vague = await send("build a dashboard of bugs per day");
    assert.equal(vague.status, 200, JSON.stringify(vague.body));
    assert.equal(vague.body.reply.importance, "needs-you");
    assert.match(vague.body.reply.text, /Which project is the dashboard for\? Pick the project in the Project box/);
    assert.equal(vague.body.user.text, "build a dashboard of bugs per day", "the person's message is kept");
    assert.equal((await cards()).length, before, "nothing was started");
  } finally {
    if (server) await stopDevNode(server);
    await new Promise<void>((resolve) => classifier.server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
