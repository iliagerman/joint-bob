import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { Express } from "express";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function listen(app: Express) {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

interface Card {
  id: string; name: string; machine: string; local: boolean; state: string; has: string[]; isDefault: boolean; mayAsk: boolean; askable: boolean; shared: boolean; reason: string | null;
  lastAsk: { question: string; answer: string | null; status: string; purpose: string; seconds: number | null } | null; askedLastDay: number;
}

test("Bob's assistants over the API: cards with what they have and why one cannot be asked, the may-ask switch is the default assistant's, and every ask is recorded and shown", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-control-assistants-"));
  const previous = { dataDir: process.env.PI_WEB_DATA_DIR, user: process.env.MASTER_BOB_ADMIN_USERNAME, password: process.env.MASTER_BOB_INITIAL_PASSWORD };
  let node: Awaited<ReturnType<typeof listen>> | undefined;
  let restore: (() => void) | undefined;
  try {
    process.env.PI_WEB_DATA_DIR = root;
    process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
    process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
    const app = await import(`../src/app.js?control-assistants=${Date.now()}-${Math.random()}`);
    node = await listen(app.createApp());
    const login = await fetch(`${node.baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }) });
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0];
    const { csrfToken } = await login.json() as { csrfToken: string };
    await fetch(`${node.baseUrl}/api/auth/change-password`, { method: "POST", headers: { Cookie: cookie, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: "initial-password", newPassword: "a-new-long-password-123" }) });
    const headers = { Cookie: cookie, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" };
    const call = async (method: string, route: string, body?: unknown) => {
      const response = await fetch(`${node!.baseUrl}/api/control-center/${route}`, { method, headers, ...body === undefined ? {} : { body: JSON.stringify(body) } });
      return { status: response.status, json: await response.json() as any };
    };

    const { listLocalUsers } = await import("../src/auth.js");
    const { getClusterNode } = await import("../src/cluster.js");
    const { clusterV2Database } = await import("../src/cluster-v2-store.js");
    const { addSharingMember, createSharingCluster, getSharingCluster, registerOwnedResource, setResourceShares } = await import("../src/cluster-sharing-policy.js");
    const { ensureConversationRecord } = await import("../src/conversation-records.js");
    const { addPersonalAssistantTopic, beginPersonalAssistantTurn, savePersonalAssistant } = await import("../src/personal-assistants.js");
    const { addProject } = await import("../src/store.js");
    const { setDefaultAssistant } = await import("../src/social/directory.js");
    const { askableHelpers } = await import("../src/assistant-collaboration/directory.js");
    const { setAskTurnRunner } = await import("../src/assistant-collaboration/ask.js");
    const { askAllowedBySwitch, asksServedBy, bobAsks, finishAsk } = await import("../src/assistant-collaboration/store.js");
    const { askAsBob, bobAskerId, bobHelperViews, toBobHelper } = await import("../src/control-center/assistants-asks.js");
    const { assistantPorts, provideAssistants } = await import("../src/control-center/assistants-runtime.js");
    const { useAssistants } = await import("../src/control-center/assistants.js");
    const { appendBobMessage, bobDatabase, DEFAULT_BOB_SETTINGS, listBobMessages } = await import("../src/control-center/bob-store.js");
    const accountId = listLocalUsers().find((user) => user.username === "admin")!.accountId;
    const local = (await getClusterNode()).id;

    async function assistantIn(name: string, instructions: string, mcpServerNames: string[] = []) {
      const folder = path.join(os.homedir(), `bob-assistants-${name}-${randomUUID()}`);
      await mkdir(folder, { recursive: true });
      const project = await addProject(name, folder, { writeInstructions: false });
      const sessionId = randomUUID();
      registerOwnedResource(await clusterV2Database(), { kind: "project", id: project.id, ownerNodeId: local }, local);
      const assistant = await savePersonalAssistant(accountId, { projectId: project.id, engine: "pi", sessionId, name, instructions, nodeId: local, mcpServerNames });
      await addPersonalAssistantTopic(accountId, assistant.id, { projectId: project.id, engine: "pi", sessionId, source: true });
      await ensureConversationRecord(project.id, "pi", sessionId, local);
      return assistant;
    }
    const personal = await assistantIn("Personal assistant", "Everyday things for Ilia");
    const work = await assistantIn("Work assistant", "Work calendar and Jira", ["Jira MCP"]);
    const shopping = await assistantIn("Shopping assistant", "Prices and orders");
    // The shopping assistant's project is shared with a team, so its answers could reach other people.
    const db = await clusterV2Database(), team = randomUUID();
    createSharingCluster(db, { id: team, name: "Team" }, local);
    addSharingMember(db, team, local, randomUUID(), getSharingCluster(db, team).managerEpoch);
    setResourceShares(db, local, "project", shopping.projectId, [{ clusterId: team, projectId: null }]);

    // The cards: every assistant of the person, with what it has, where it runs, and why one can't be asked.
    const cards = (await call("GET", "assistants")).json.assistants as Card[];
    assert.deepEqual(cards.map((card) => card.name), ["Personal assistant", "Shopping assistant", "Work assistant"]);
    const byName = (list: Card[], name: string) => list.find((card) => card.name === name)!;
    assert.deepEqual(byName(cards, "Work assistant").has, ["Jira MCP"]);
    assert.deepEqual([byName(cards, "Work assistant").local, byName(cards, "Work assistant").state, byName(cards, "Work assistant").mayAsk, byName(cards, "Work assistant").askable, byName(cards, "Work assistant").lastAsk], [true, "idle", true, true, null]);
    assert.equal(byName(cards, "Work assistant").machine.length > 0, true);
    const closed = byName(cards, "Shopping assistant");
    assert.deepEqual([closed.shared, closed.askable, closed.mayAsk], [true, false, true]);
    assert.match(closed.reason!, /Shopping assistant is in a shared project, so Bob can't ask it/);

    // Bob's side of the switch is the person's default assistant; with none it is Bob's own.
    assert.equal(await bobAskerId(accountId), `bob-of:${accountId}`);
    const off = await call("PUT", `assistants/${work.id}/may-ask`, { enabled: false });
    assert.deepEqual([off.json.assistant.mayAsk, off.json.assistant.askable, off.json.assistant.reason], [false, false, "Bob may not ask it: the switch is off."]);
    assert.equal(await askAllowedBySwitch(`bob-of:${accountId}`, work.id), false);
    assert.equal(byName((await call("GET", "assistants")).json.assistants, "Work assistant").mayAsk, false);
    assert.equal((await call("PUT", `assistants/${work.id}/may-ask`, { enabled: true })).json.assistant.askable, true);
    assert.equal((await call("PUT", `assistants/${shopping.id}/may-ask`, { enabled: true })).status, 409, "a shared project's assistant can't be turned on");
    assert.equal((await call("PUT", `assistants/${shopping.id}/may-ask`, { enabled: false })).status, 200, "but it can be left off");
    assert.equal((await call("PUT", `assistants/${shopping.id}/may-ask`, { enabled: true })).status, 409);
    assert.equal((await call("PUT", `assistants/${work.id}/may-ask`, { enabled: "yes" })).status, 400);
    assert.equal((await call("PUT", `assistants/${work.id}/may-ask`, { enabled: true, extra: 1 })).status, 400);
    assert.equal((await call("PUT", "assistants/not-an-id/may-ask", { enabled: true })).status, 400);
    assert.equal((await call("PUT", `assistants/${randomUUID()}/may-ask`, { enabled: true })).status, 404);
    assert.equal((await call("GET", "assistants/not-an-id/asks")).status, 400);

    await setDefaultAssistant(accountId, personal.id);
    assert.equal(await bobAskerId(accountId), personal.id);
    assert.equal(byName((await call("GET", "assistants")).json.assistants, "Personal assistant").isDefault, true);
    await call("PUT", `assistants/${work.id}/may-ask`, { enabled: false });
    assert.equal(await askAllowedBySwitch(personal.id, work.id), false, "the switch is the default assistant's own one");
    const seenByDefault = (await askableHelpers(personal)).find((view) => view.id === work.id)!;
    assert.deepEqual([seenByDefault.available, seenByDefault.reason], [false, "Turned off for this assistant."], "the assistants' own screens show the same switch");
    await call("PUT", `assistants/${work.id}/may-ask`, { enabled: true });
    assert.equal(await askAllowedBySwitch(personal.id, work.id), true);

    // Bob asks: a normal turn of the helper as the owner, recorded, with the helper's answer.
    const turns: Array<Record<string, unknown>> = [];
    let finishPending: ((answer: string) => void) | undefined;
    const answers = new Map<string, string | "pending">([[work.id, "Two meetings tomorrow: 10:00 standup, 14:00 Noa"]]);
    setAskTurnRunner(async (account, helperId, requestId, message, options) => {
      turns.push({ account, helperId, message, label: options.label, origin: options.origin });
      const answer = answers.get(helperId) ?? "nothing";
      const response = answer === "pending" ? await new Promise<string>((resolve) => { finishPending = resolve; }) : answer;
      return { requestId, topicId: "pi:helper-topic", message, response, status: "completed", createdAt: new Date().toISOString() };
    });
    restore = () => setAskTurnRunner(undefined);
    const view = (await bobHelperViews(accountId)).find((candidate) => candidate.id === work.id)!;
    const asked = await askAsBob(accountId, toBobHelper(view), "What work meetings do I have tomorrow?", "Jira MCP", { waitMs: 10_000 });
    assert.deepEqual([asked.status, asked.answer], ["completed", "Two meetings tomorrow: 10:00 standup, 14:00 Noa"]);
    assert.deepEqual(turns, [{ account: accountId, helperId: work.id, message: "What work meetings do I have tomorrow?", label: "Assistant", origin: "assistant" }], "a turn of the helper as the owner, marked as an assistant's so it cannot ask a third");
    const [recorded] = await bobAsks(accountId, 10);
    assert.deepEqual([recorded.askerName, recorded.askerId, recorded.helperId, recorded.purpose, recorded.status], ["Bob", personal.id, work.id, "Jira MCP", "completed"]);
    assert.match(recorded.askerTurnRequestId!, /^bob:/);
    assert.deepEqual((await asksServedBy(work.id)).map((record) => [record.askerName, record.question]), [["Bob", "What work meetings do I have tomorrow?"]], "the helper's own ask log has it");
    const shown = (await call("GET", `assistants/${work.id}/asks`)).json.asks;
    assert.deepEqual(shown.map((ask: { question: string; answer: string; status: string; purpose: string; helperName: string }) => [ask.helperName, ask.purpose, ask.status, ask.question, ask.answer]),
      [["Work assistant", "Jira MCP", "completed", "What work meetings do I have tomorrow?", "Two meetings tomorrow: 10:00 standup, 14:00 Noa"]]);
    assert.deepEqual((await call("GET", `assistants/${personal.id}/asks`)).json.asks, [], "only what was asked of that assistant");
    const afterAsk = byName((await call("GET", "assistants")).json.assistants, "Work assistant");
    assert.deepEqual([afterAsk.state, afterAsk.askedLastDay, afterAsk.lastAsk?.status, afterAsk.lastAsk?.question], ["idle", 1, "completed", "What work meetings do I have tomorrow?"]);

    // Refused now, on every ask: a switch turned off, a project that became shared, an assistant that is gone.
    await call("PUT", `assistants/${work.id}/may-ask`, { enabled: false });
    const refused = await askAsBob(accountId, toBobHelper(view), "Again?", "Jira MCP", { waitMs: 1_000 });
    assert.deepEqual([refused.status, refused.error], ["failed", "Bob may not ask it: the switch is off."]);
    await call("PUT", `assistants/${work.id}/may-ask`, { enabled: true });
    const shared = await askAsBob(accountId, toBobHelper({ ...view, id: shopping.id, name: "Shopping assistant" }), "Price?", "x", { waitMs: 1_000 });
    assert.equal(shared.status, "failed");
    assert.match(shared.error!, /shared project/);
    const gone = await askAsBob(accountId, { id: randomUUID(), name: "Ghost", about: "", has: [] }, "Hello?", "x", { waitMs: 1_000 });
    assert.match(gone.error!, /no longer one of your assistants/);
    assert.equal((await bobAsks(accountId, 10)).length, 1, "a refused ask is not recorded as an ask");

    // While an assistant works on Bob's ask the card says so; a person's own running turn makes it busy.
    answers.set(work.id, "pending");
    const slow = await askAsBob(accountId, toBobHelper(view), "Anything on Friday?", "Jira MCP", { waitMs: 100 });
    assert.deepEqual([slow.status, slow.answer], ["running", null]);
    assert.equal(byName((await call("GET", "assistants")).json.assistants, "Work assistant").state, "answering-bob");
    await beginPersonalAssistantTurn(accountId, personal.id, randomUUID(), `pi:${personal.sessionId}`, "What is on tomorrow?", "chat");
    assert.equal(byName((await call("GET", "assistants")).json.assistants, "Personal assistant").state, "busy");
    finishPending!("Friday is free");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(byName((await call("GET", "assistants")).json.assistants, "Work assistant").state, "idle");
    assert.equal((await call("GET", `assistants/${work.id}/asks`)).json.asks[0].answer, "Friday is free", "the answer is kept with the ask though nobody waited");

    // The whole thing for one message: the chosen assistant is asked, the answer and a note come back.
    answers.set(work.id, "Standup at 10:00");
    const turn = { session: { id: "browser", accountId } as never, message: "what work meetings do I have tomorrow?", recentChat: ["hi", "hello"], project: null, options: [], settings: { ...DEFAULT_BOB_SETTINGS } };
    const yes = { stateCharacters: 100_000, async ask(_state: string, questions: Record<string, { instructions: string }>) {
      return Object.fromEntries(Object.entries(questions).map(([key, question]) => [key, { choice: question.instructions.includes('"Work assistant"') ? "yes" : "no", confidence: 0.99 }]));
    } };
    const contribution = await useAssistants(turn, assistantPorts(turn, 10_000, { pickDeps: async () => yes }));
    assert.match(contribution!.text, /### Work assistant[^\n]*\nStandup at 10:00/);
    assert.match(contribution!.via!, /^Asked Work assistant · Jira MCP · \d+ s$/);
    assert.equal(turns.at(-1)!.helperId, work.id, "only the assistant the model said yes to");
    assert.ok(!(await bobAsks(accountId, 20)).some((record) => record.helperId === personal.id || record.helperId === shopping.id));
    assert.match((await bobAsks(accountId, 1))[0].question, /The owner's message:\nwhat work meetings do I have tomorrow\?\n\nEarlier in the chat/);

    // Never for a turn a webhook started: no model call, no ask.
    const before = (await bobAsks(accountId, 50)).length;
    const hooked = { ...turn, session: { id: `automation:${accountId}`, accountId } as never };
    assert.equal(await provideAssistants(hooked), null);
    assert.equal((await bobAsks(accountId, 50)).length, before);

    // With real wiring and no decision model, Bob's agent chooses; when it cannot run, Bob says so instead of staying silent.
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      const stuck = await provideAssistants({ ...turn, settings: { ...DEFAULT_BOB_SETTINGS, harnessId: "no-such-agent" } });
      assert.equal(stuck!.via, "Could not choose which assistants to ask");
    } finally { console.warn = warn; }

    // An answer that comes after Bob replied is posted in the chat.
    answers.set(work.id, "pending");
    finishPending = undefined;
    const late = await assistantPorts(turn, 100).askHelper(toBobHelper(view), "Late one?", "Jira MCP");
    assert.equal(late.status, "running");
    finishPending!("It was slow, but: yes");
    const chat = await bobDatabase();
    let posted: ReturnType<typeof listBobMessages> = [];
    for (let attempt = 0; attempt < 50 && !posted.length; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      posted = listBobMessages(chat, accountId).filter((message) => message.text.startsWith("Work assistant answered after I had replied"));
    }
    assert.equal(posted.length, 1);
    assert.match(posted[0].text, /It was slow, but: yes/);
    assert.match(posted[0].via!, /^Asked Work assistant · Jira MCP · \d+ s$/);
    appendBobMessage(chat, accountId, { role: "user", text: "check" });

    // Another person's account sees none of it.
    assert.equal((await bobAsks("someone-else", 10)).length, 0);
  } finally {
    restore?.();
    await node?.close();
    for (const [key, value] of [["PI_WEB_DATA_DIR", previous.dataDir], ["MASTER_BOB_ADMIN_USERNAME", previous.user], ["MASTER_BOB_INITIAL_PASSWORD", previous.password]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
