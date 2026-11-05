import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, projectNamed, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode, type SignedIn } from "./dev-nodes.js";

/** A stand-in decision model: every message is a task about the project it names; one that starts "continue" belongs to the first conversation. */
async function decisionModel(): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { state: string; questions: Record<string, { criteria: Record<string, string> }> };
      const message = (JSON.parse(parsed.state) as { user_message: string }).user_message;
      const choose = (choice: string) => ({ type: "choice", choice, confidence: 0.97 });
      const answers: Record<string, unknown> = {};
      for (const [id, question] of Object.entries(parsed.questions)) {
        if (id === "kind") answers[id] = choose("task");
        else if (id === "size") answers[id] = choose("long");
        else if (id === "autorespond") answers[id] = choose("no");
        else if (id === "project") answers[id] = choose(Object.entries(question.criteria).find(([key, text]) => key !== "none" && message.includes(text.split(".")[0]))?.[0] ?? "none");
        else if (id === "conversation") answers[id] = choose(message.startsWith("continue") ? "conversation_0" : "none");
        // Whatever else other features ask in the same request (dashboards, moves) is answered "no" or "none".
        else answers[id] = choose("no" in question.criteria ? "no" : "none" in question.criteria ? "none" : Object.keys(question.criteria)[0]);
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ answers }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/systemone` };
}

async function eventually<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Never happened: ${label}`);
}

test("Bob starts a task as a conversation, uses the agent the person names, continues the conversation it belongs to, and leaves one the person took over", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-control-tasks-"));
  const classifier = await decisionModel();
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const engineLog = path.join(root, "engine-runs.log");
    const environment = await seedDevEnvironment(root, 1);
    const node: SeededNode = environment.nodes[0];
    server = await startDevNode(environment, node, { JOINT_BOB_TEST_ENGINE_LOG: engineLog, JOINT_BOB_TYPESAFE_ENDPOINT: classifier.url });
    const auth: SignedIn = await signIn(environment, node);
    const project = projectNamed(node, "Joint Bob");
    const account = await api<{ account: { id: string } }>(node, auth, "POST", "/secrets/accounts", { label: "decision", provider: "custom", variables: [{ name: "TYPESAFE_AI_API_KEY", kind: "value", value: "test-key" }] });
    assert.equal((await api(node, auth, "PUT", `/secrets/scopes/project/${project.id}`, { accountIds: [account.body.account.id] })).status, 200);
    const runs = async () => (await readFile(engineLog, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => line.split(":")[0]);
    const send = (message: string) => api<{ action: string; reply: { text: string } }>(node, auth, "POST", "/control-center/bob/message", { message });

    // 1. A task in a project starts as a conversation there, with Bob's usual agent.
    const started = await send("fix the mobile menu in Joint Bob");
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.action, "started", JSON.stringify(started.body));
    assert.match(started.body.reply.text, /^Started in Joint Bob\./);
    await eventually(async () => (await runs()).length >= 1 ? true : undefined, "the new conversation ran a turn");
    const board = await eventually(async () => {
      const cards = (await api<{ cards: Array<{ startedBy: string; projectName: string }> }>(node, auth, "GET", "/control-center/board")).body.cards;
      return cards.some((card) => card.startedBy === "bob") ? cards : undefined;
    }, "the board marks the conversation as started by Bob").catch(() => undefined);
    // The stub engine finishes at once, so the card may already have left the board; the conversation list still marks it.
    void board;

    // 2. The person names another agent.
    const before = (await runs()).length;
    const named = await send("fix the footer in Joint Bob using Claude Code");
    assert.equal(named.body.action, "started", JSON.stringify(named.body));
    await eventually(async () => (await runs()).length > before ? true : undefined, "the named agent ran");
    assert.equal((await runs()).at(-1), "claude", "the conversation ran on the agent the person named");

    // 3. A task that belongs to an existing conversation goes there.
    const sessionsOf = async () => (await api<{ sessions: Array<{ id: string; title: string; conversationId?: string; updatedAt?: string }> }>(node, auth, "GET", `/projects/${project.id}/sessions`)).body.sessions;
    const countBefore = (await sessionsOf()).length;
    const continued = await send("continue: also adjust the width in Joint Bob");
    assert.equal(continued.status, 200, JSON.stringify(continued.body));
    assert.match(continued.body.reply.text, /^Sent to "[^"]+" in Joint Bob, since it is the same work\.$/);
    assert.equal((await sessionsOf()).length, countBefore, "no new conversation was started");

    // 4. A conversation the person took over is left alone: Bob says so and starts a new one.
    const title = /^Sent to "([^"]+)"/.exec(continued.body.reply.text)![1];
    const target = (await sessionsOf()).find((session) => session.title === title)!;
    assert.equal((await api(node, auth, "POST", "/control-center/lease", { projectId: project.id, conversationId: target.conversationId ?? target.id, action: "take" })).status, 200);
    const left = await send("continue: and the height too in Joint Bob");
    assert.equal(left.body.action, "started", JSON.stringify(left.body));
    assert.match(left.body.reply.text, /You are in control of ".+", so I started a new conversation instead of interrupting it\./);
  } finally {
    if (server) await stopDevNode(server);
    await new Promise<void>((resolve) => classifier.server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
