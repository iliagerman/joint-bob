import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { SystemOneChoice, SystemOneQuestion } from "../src/classifiers/typesafe.js";
import { bobDashboardIds, ensureMadeSchema, recordBobDashboard } from "../src/control-center/dashboards-made.js";
import { DEFAULT_BOB_SETTINGS, ensureBobSchema } from "../src/control-center/bob-store.js";
import { DASHBOARD_QUESTIONS, decideDashboardIntent, parseDashboardIntent } from "../src/control-center/dashboard-intent.js";
import { bobDashboardRequest } from "../src/server/control-center-dashboard-request.js";

type Answers = Record<string, SystemOneChoice> | null;

/** A stand-in decision model: answers the two dashboard questions with the given choices. */
function fakeAsk(project: "yes" | "no", me: "yes" | "no", confidence = 0.97, answers?: Answers) {
  const requests: Array<{ state: string; questions: string[] }> = [];
  const ask = async (state: string, questions: Record<string, SystemOneQuestion>): Promise<Answers> => {
    requests.push({ state, questions: Object.keys(questions) });
    return answers === undefined ? { dashboard_project: { choice: project, confidence }, dashboard_me: { choice: me, confidence } } : answers;
  };
  return { ask, requests };
}

const noAgent = async (): Promise<string> => { throw new Error("the agent must not be asked"); };

test("a confident decision model answers both dashboard questions in one request and the agent is not asked", async () => {
  const model = fakeAsk("yes", "no");
  const result = await decideDashboardIntent({ message: "build a dashboard of bugs per day for julian", recentChat: ["hi"], threshold: 0.9, ask: model.ask, stateCharacters: 120_000, agent: noAgent });
  assert.deepEqual(result, { intent: { project: true, me: false }, by: "decision model", confidence: 0.97 });
  assert.equal(model.requests.length, 1);
  assert.deepEqual(model.requests[0].questions.sort(), ["dashboard_me", "dashboard_project"]);
  assert.equal(JSON.parse(model.requests[0].state).user_message, "build a dashboard of bugs per day for julian");
  // Both can be asked for in one message.
  const both = await decideDashboardIntent({ message: "one for julian and one for me", recentChat: [], threshold: 0.9, ask: fakeAsk("yes", "yes").ask, stateCharacters: 120_000, agent: noAgent });
  assert.deepEqual(both?.intent, { project: true, me: true });
  // And neither: an ordinary message is not a dashboard request.
  const neither = await decideDashboardIntent({ message: "what is running?", recentChat: [], threshold: 0.9, ask: fakeAsk("no", "no").ask, stateCharacters: 120_000, agent: noAgent });
  assert.deepEqual(neither?.intent, { project: false, me: false });
});

test("a long message is cut to what the decision model can read", async () => {
  const model = fakeAsk("no", "no");
  await decideDashboardIntent({ message: "x".repeat(9_000), recentChat: [], threshold: 0.9, ask: model.ask, stateCharacters: 3_500, agent: noAgent });
  assert.ok(model.requests[0].state.length <= 3_500, `the state fits the model, got ${model.requests[0].state.length}`);
});

test("under the confidence threshold, or with no decision model, Bob's agent decides, but only about a message that mentions a dashboard", async () => {
  const prompts: string[] = [];
  const agent = async (message: string) => { prompts.push(message); return 'Here you go:\n```json\n{"project": false, "me": true}\n```'; };
  const unsure = await decideDashboardIntent({ message: "I want a dashboard for me", recentChat: [], threshold: 0.9, ask: fakeAsk("yes", "no", 0.6).ask, stateCharacters: 120_000, agent });
  assert.deepEqual(unsure, { intent: { project: false, me: true }, by: "agent" }, "the model's 60% is not used");
  const unavailable = await decideDashboardIntent({ message: "a dashboard please", recentChat: [], threshold: 0.9, ask: fakeAsk("no", "no", 1, null).ask, stateCharacters: 120_000, agent });
  assert.equal(unavailable?.by, "agent", "a model that could not answer leaves it to the agent");
  const none = await decideDashboardIntent({ message: "a dashboard please", recentChat: [], threshold: 0.9, ask: null, stateCharacters: 0, agent });
  assert.equal(none?.by, "agent");
  assert.equal(prompts.length, 3);
  // A message that does not mention a dashboard never costs an agent run.
  assert.equal(await decideDashboardIntent({ message: "what is running?", recentChat: [], threshold: 0.9, ask: null, stateCharacters: 0, agent: noAgent }), null);
  assert.equal(await decideDashboardIntent({ message: "what is running?", recentChat: [], threshold: 0.9, ask: fakeAsk("yes", "yes", 0.5).ask, stateCharacters: 120_000, agent: noAgent }), null);
});

test("the agent's answer is accepted only as exactly the requested JSON", async () => {
  assert.deepEqual(parseDashboardIntent('{"project": true, "me": false}'), { project: true, me: false });
  assert.deepEqual(parseDashboardIntent('Sure.\n{"me": true, "project": true}\nDone.'), { project: true, me: true });
  for (const text of ["yes please", "{}", '{"project": "yes", "me": false}', '{"project": true, "me": false, "extra": 1}', '{"project": true}', "{not json}", '["project"]']) {
    assert.equal(parseDashboardIntent(text), null, text);
  }
  const garbled = await decideDashboardIntent({ message: "a dashboard", recentChat: [], threshold: 0.9, ask: null, stateCharacters: 0, agent: async () => "I think the user wants one" });
  assert.equal(garbled, null, "free text is never taken as a decision");
});

test("the questions are plain yes or no choices", () => {
  for (const question of Object.values(DASHBOARD_QUESTIONS)) assert.deepEqual(Object.keys(question.criteria), ["yes", "no"]);
});

test("the dashboards Bob made are remembered per person", () => {
  const db = new DatabaseSync(":memory:");
  ensureMadeSchema(db);
  recordBobDashboard(db, "ilia", "d1", "a dashboard of bugs");
  recordBobDashboard(db, "ilia", "d1", "asked twice");
  recordBobDashboard(db, "dana", "d2", "hers");
  assert.deepEqual([...bobDashboardIds(db, "ilia")], ["d1"]);
  assert.deepEqual([...bobDashboardIds(db, "dana")], ["d2"]);
  assert.deepEqual([...bobDashboardIds(db, "nobody")], []);
});

/** The decision model as an HTTP server, because Bob asks it through its real client. */
async function decisionModel(project: "yes" | "no", me: "yes" | "no", confidence = 0.97) {
  const requests: Array<{ questions: string[]; state: string }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { state: string; questions: Record<string, unknown> };
      requests.push({ questions: Object.keys(parsed.questions), state: parsed.state });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ answers: {
        dashboard_project: { type: "choice", choice: project, confidence },
        dashboard_me: { type: "choice", choice: me, confidence },
      } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    requests,
    target: { endpoint: `http://127.0.0.1:${port}/v1/systemone`, model: "test", stateCharacters: 120_000, timeoutMs: 5_000 },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function bobDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureBobSchema(db);
  return db;
}

const project = { id: "p1", name: "Joint Bob", path: "/tmp/p1", createdAt: "", updatedAt: "" };
const baseRequest = { session: { accountId: "ilia" } as never, settings: { ...DEFAULT_BOB_SETTINGS, threshold: 0.9 }, recentChat: [], projects: [project], decision: null };

test("Bob asks which project instead of guessing one", async () => {
  const model = await decisionModel("yes", "no");
  try {
    const db = bobDatabase();
    const reply = await bobDashboardRequest({ ...baseRequest, db, message: "build a dashboard of bugs per day", project: undefined, model: { target: model.target, apiKey: "key" } });
    assert.ok(reply);
    assert.equal(reply.importance, "needs-you");
    assert.match(reply.text, /Which project is the dashboard for\?/);
    assert.match(reply.text, /Project box/);
    assert.match(reply.via ?? "", /Dashboards · decision model 97%/);
    assert.deepEqual(reply.actions, []);
    assert.equal(model.requests.length, 1, "one request, both questions");
  } finally { await model.close(); }
});

test("a message that is not a dashboard request goes on to Bob's usual answer, and a question is not even checked", async () => {
  const model = await decisionModel("no", "no");
  try {
    const db = bobDatabase();
    const sent = { ...baseRequest, db, project, model: { target: model.target, apiKey: "key" } };
    assert.equal(await bobDashboardRequest({ ...sent, message: "fix the mobile menu" }), null);
    assert.equal(model.requests.length, 1);
    const asked = await bobDashboardRequest({ ...sent, message: "what dashboards do I have?", decision: { kind: "question", size: "short", projectId: null, confidence: 0.95 } });
    assert.equal(asked, null);
    const automation = await bobDashboardRequest({ ...sent, message: "pause the dashboard refresh schedule", decision: { kind: "automation", size: "short", projectId: null, confidence: 0.95 } });
    assert.equal(automation, null);
    assert.equal(model.requests.length, 1, "a question and an automation change cost no extra decision");
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM control_center_bob_messages").get()!.total, 0, "nothing was said");
    assert.equal(await bobDashboardRequest({ ...sent, projects: [], message: "a dashboard" }), null, "with no project there is nothing to build in");
  } finally { await model.close(); }
});

test("a dashboard for the person with no workspace to put it in is asked about, not guessed", async () => {
  const model = await decisionModel("no", "yes");
  try {
    const db = bobDatabase();
    // None of the test's projects is in a workspace, so there is no workspace to choose from.
    const reply = await bobDashboardRequest({ ...baseRequest, db, message: "a dashboard for me", project: undefined, model: { target: model.target, apiKey: "key" } });
    assert.ok(reply);
    assert.equal(reply.importance, "needs-you");
    assert.match(reply.text, /Which workspace is your own dashboard for\?/);
  } finally { await model.close(); }
});

test("Bob's own agent is told what dashboards are, and that there are none yet", async () => {
  await import("../src/server/control-center-dashboard-cards.js");
  const { collectBobContext } = await import("../src/control-center/bob-hooks.js");
  const found = await collectBobContext({ session: { accountId: "ilia", userId: "ilia" } as never, message: "can you build me a dashboard?", recentChat: [], project: null, options: [], settings: DEFAULT_BOB_SETTINGS });
  assert.match(found.text, /the person can ask you to build a dashboard for a project or for themselves/);
  assert.match(found.text, /Ask Bob to change it/);
  assert.match(found.text, /There are no dashboards yet\./);
});
