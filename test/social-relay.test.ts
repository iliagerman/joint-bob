// Discoverable assistants, direct requests and groups across a real relay. Three machines:
// r serves the relay, a is Ilia's (with an assistant), b is Noa's. The decision model and
// Google Calendar are loopback stand-ins; nothing reaches a real service.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";

async function api<T>(node: SeededNode, session: SignedIn, method: string, endpoint: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${node.url}/api${endpoint}`, {
    method, headers: { Cookie: session.cookie, "x-csrf-token": session.csrfToken, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
}
async function eventually<T>(check: () => Promise<T>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return await check(); } catch (error) { if (Date.now() > deadline) throw error; }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
}

interface Fixture { url: string; decisions: Array<{ questions: string[]; state: Record<string, unknown> }>; events: Array<{ id: string; summary: string; start: string }>; close(): Promise<void> }

/** Stand-ins: a decision model that judges by fixed rules, and a Google Calendar. */
async function fixtures(): Promise<Fixture> {
  const decisions: Fixture["decisions"] = [];
  const events: Fixture["events"] = [];
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", chunk => { raw += chunk; });
    request.on("end", () => {
      const json = (status: number, body: unknown) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      const url = new URL(request.url ?? "/", "http://fixture");
      if (url.pathname === "/v1/systemone") {
        const body = JSON.parse(raw) as { state: string; questions: Record<string, { criteria: Record<string, string> }> };
        const state = JSON.parse(body.state) as Record<string, unknown>;
        decisions.push({ questions: Object.keys(body.questions), state });
        const answers: Record<string, unknown> = {};
        for (const [id, question] of Object.entries(body.questions)) {
          let choice = Object.keys(question.criteria)[0];
          if (id === "outcome") {
            const text = String((state.new_message as { text: string }).text).toLowerCase();
            const actions = (state.published_actions as Array<{ option: string; name: string }>) ?? [];
            const action = (name: string) => actions.find(item => item.name === name)?.option;
            choice = text.includes("what do you think") ? "draft_reply" : text.includes("notes") ? "unpublished" : text.includes("budget") ? "notify_owner" : text.includes("travel") ? action("Share my travel plan")! : /meet|30 minutes|vendor/.test(text) ? action("Arrange a meeting")! : "record";
          }
          if (id === "disposition") choice = (state.caller as { name: string }).name === "dan" ? "execute" : "ask_owner";
          answers[id] = { type: "choice", choice, confidence: 0.9 };
        }
        json(200, { answers });
        return;
      }
      if (url.pathname === "/token") { json(200, { access_token: "fixture-token", expires_in: 3600 }); return; }
      if (request.headers.authorization !== "Bearer fixture-token") { json(401, { error: "unauthorized" }); return; }
      if (url.pathname === "/calendar/v3/calendars/primary") { json(200, { timeZone: "UTC" }); return; }
      if (url.pathname === "/calendar/v3/freeBusy") {
        const { timeMin, timeMax } = JSON.parse(raw) as { timeMin: string; timeMax: string };
        const busy = events.filter(event => event.start < timeMax && new Date(new Date(event.start).getTime() + 30 * 60_000).toISOString() > timeMin)
          .map(event => ({ start: event.start, end: new Date(new Date(event.start).getTime() + 30 * 60_000).toISOString() }));
        json(200, { calendars: { primary: { busy } } });
        return;
      }
      if (url.pathname === "/calendar/v3/calendars/primary/events" && request.method === "POST") {
        const event = JSON.parse(raw) as { id: string; summary: string; start: { dateTime: string } };
        if (events.some(item => item.id === event.id)) { json(409, { error: "duplicate" }); return; }
        events.push({ id: event.id, summary: event.summary, start: event.start.dateTime });
        json(200, { id: event.id, htmlLink: `https://calendar.example/${event.id}` });
        return;
      }
      json(404, { error: "not found" });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, decisions, events, close: () => new Promise(resolve => server.close(() => resolve())) };
}

test("people and assistants find each other on a relay, request public actions and share groups", { timeout: 420_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "social-relay-"));
  const fixture = await fixtures();
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const environments: DevEnvironment[] = [
      await seedDevEnvironment(path.join(root, "r"), 1, { username: "relay" }),
      await seedDevEnvironment(path.join(root, "a"), 1, { username: "ilia" }),
      await seedDevEnvironment(path.join(root, "b"), 1, { username: "noa" }),
    ];
    const [r, a, b] = environments.map(environment => environment.nodes[0]);
    const draftWriter = path.join(os.tmpdir(), `draft-writer-${randomUUID()}.mjs`);
    await writeFile(draftWriter, "export default async ({ material }) => { const { new_message: message } = JSON.parse(material); return `Thanks, ${message.author}. I like it.`; };\n");
    const env = { JOINT_BOB_TYPESAFE_ENDPOINT: `${fixture.url}/v1/systemone`, JOINT_BOB_GOOGLE_TOKEN_ENDPOINT: `${fixture.url}/token`, JOINT_BOB_GOOGLE_CALENDAR_ENDPOINT: `${fixture.url}/calendar/v3`, JOINT_BOB_DRAFT_GENERATOR: draftWriter };
    for (const [index, node] of [r, a, b].entries()) children.push(await startDevNode(environments[index], node, env));
    const [sr, sa, sb] = await Promise.all([signIn(environments[0], r), signIn(environments[1], a), signIn(environments[2], b)]);

    assert.equal((await api(r, sr, "PUT", "/relay/serving", { enabled: true, origin: `http://localhost:${r.port}`, environment: "test", requestsEnabled: true, maxMachines: 10, monthlyCapGb: 0, alertTopic: "" })).status, 204);
    for (const [node, session, label] of [[a, sa, "alpha"], [b, sb, "bravo"]] as const) {
      assert.equal((await api(node, session, "PUT", "/cluster/node", { name: label, url: "" })).status, 200);
      const token = await api<{ link: string }>(r, sr, "POST", "/relay/serving/tokens", { label });
      assert.equal((await api(node, session, "POST", "/relays", { link: token.body.link })).status, 201);
    }
    type Me = { account: { accountId: string }; relays: Array<{ relayNodeId: string; active: boolean }>; assistants: Array<{ id: string }> };
    const meA = await eventually(async () => { const me = await api<Me>(a, sa, "GET", "/social/me"); assert.equal(me.body.relays[0]?.active, true, JSON.stringify(me.body)); return me.body; }, 90_000);
    const meB = await eventually(async () => { const me = await api<Me>(b, sb, "GET", "/social/me"); assert.equal(me.body.relays[0]?.active, true, JSON.stringify(me.body)); return me.body; }, 90_000);
    const relayNodeId = meA.relays[0].relayNodeId;
    assert.equal(meB.relays[0].relayNodeId, relayNodeId);

    // Ilia's assistant, with a decision-model key and a Google account attached to its conversation.
    const projectId = a.projects[0].id;
    const conversation = (await api<{ sessions: Array<{ id: string; harnessId: string }> }>(a, sa, "GET", `/projects/${projectId}/sessions`)).body.sessions[0];
    const created = await api<{ assistant: { id: string } }>(a, sa, "POST", "/personal-assistants", { projectId, engine: conversation.harnessId, sessionId: conversation.id, name: "Work assistant", instructions: "Help people who ask about my time." });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const assistantId = created.body.assistant.id;
    const credential = JSON.stringify({ type: "authorized_user", client_id: "fixture", client_secret: "fixture", refresh_token: "fixture" });
    const secret = await api<{ account: { id: string } }>(a, sa, "POST", "/secrets/accounts", { label: "Fixture keys", provider: "custom", variables: [{ name: "TYPESAFE_AI_API_KEY", kind: "value", value: "fixture-key" }, { name: "GOOGLE_CREDENTIALS_JSON", kind: "value", value: credential }] });
    assert.equal(secret.status, 201, JSON.stringify(secret.body));
    assert.equal((await api(a, sa, "PUT", `/secrets/scopes/conversation/${encodeURIComponent(`${conversation.harnessId}:${conversation.id}`)}`, { accountIds: [secret.body.account.id] })).status, 200);

    // Discovery starts off; nothing is found until each side opts in.
    assert.deepEqual((await api<{ results: unknown[] }>(b, sb, "GET", "/social/search?q=ilia")).body.results, [], "discovery is off by default");
    assert.equal((await api(a, sa, "PUT", "/social/discovery", { subjectKind: "person", subjectId: meB.account.accountId, relayNodeId, enabled: true })).status, 403, "nobody can list someone else");
    for (const subject of [{ subjectKind: "person", subjectId: meA.account.accountId }, { subjectKind: "assistant", subjectId: assistantId }]) {
      assert.equal((await api(a, sa, "PUT", "/social/discovery", { ...subject, relayNodeId, enabled: true })).status, 200);
    }
    assert.equal((await api(b, sb, "PUT", "/social/discovery", { subjectKind: "person", subjectId: meB.account.accountId, relayNodeId, enabled: true })).status, 200);
    assert.equal((await api(a, sa, "PUT", "/social/default-assistant", { assistantId })).status, 200);

    // Public actions: a draft with no operation can't be published.
    const draft = await api<{ action: { id: string } }>(a, sa, "POST", `/personal-assistants/${assistantId}/actions`, { name: "Arrange a meeting", description: "Books 15 to 60 minutes with me.", inputs: "Day, time, length", instructions: "Book dan directly. Ask me first for anyone else.", operations: [], shareText: "" });
    assert.equal(draft.status, 201, JSON.stringify(draft.body));
    assert.equal((await api(a, sa, "POST", `/personal-assistants/${assistantId}/actions/${draft.body.action.id}/status`, { status: "published" })).status, 409, "an action without an enforceable operation stays a draft");
    const meeting = await api<{ action: { id: string; revision: number } }>(a, sa, "PUT", `/personal-assistants/${assistantId}/actions/${draft.body.action.id}`, { name: "Arrange a meeting", description: "Books 15 to 60 minutes with me.", inputs: "Day, time, length", instructions: "Book dan directly. Ask me first for anyone else.", operations: ["calendar.freebusy", "calendar.create"], shareText: "" });
    assert.equal(meeting.status, 200, JSON.stringify(meeting.body));
    assert.equal((await api(a, sa, "POST", `/personal-assistants/${assistantId}/actions/${draft.body.action.id}/status`, { status: "published" })).status, 200);
    const travel = await api<{ action: { id: string } }>(a, sa, "POST", `/personal-assistants/${assistantId}/actions`, { name: "Share my travel plan", description: "When I'm away.", inputs: "", instructions: "Anyone may know the dates.", operations: ["info.share"], shareText: "Away 10–14 Nov." });
    assert.equal((await api(a, sa, "POST", `/personal-assistants/${assistantId}/actions/${travel.body.action.id}/status`, { status: "published" })).status, 200);
    const tested = await api<{ decision: string; detail: string }>(a, sa, "POST", `/personal-assistants/${assistantId}/actions/${draft.body.action.id}/test`, { callerName: "dan", text: "Thursday at 15:00 for 30 minutes" });
    assert.equal(tested.body.decision, "execute", JSON.stringify(tested.body));
    assert.equal(fixture.events.length, 0, "a test never touches the calendar");

    // One search finds Ilia and the assistant through the relay, with its public actions only.
    type Result = { kind: string; id: string; nodeId: string; ownerAccountId?: string; ownerName?: string; relays: string[]; actions?: Array<{ name: string }> };
    const found = await eventually(async () => {
      const search = await api<{ results: Result[]; relays: Array<{ status: string }> }>(b, sb, "GET", "/social/search?q=");
      assert.equal(search.body.relays[0]?.status, "ok");
      assert.ok(search.body.results.some(result => result.kind === "assistant"), JSON.stringify(search.body));
      return search.body.results;
    });
    const listedAssistant = found.find(result => result.kind === "assistant")!;
    const listedIlia = found.find(result => result.kind === "person" && result.id === meA.account.accountId)!;
    assert.ok(listedIlia, "Ilia is listed as a person");
    assert.equal(listedAssistant.ownerName, "ilia");
    assert.deepEqual(listedAssistant.actions?.map(action => action.name).sort(), ["Arrange a meeting", "Share my travel plan"]);
    assert.equal(JSON.stringify(found).includes("Ask me first"), false, "private instructions never reach a listing");
    assert.equal(found.some(result => result.kind === "person" && result.id === meB.account.accountId), false, "searchers don't find themselves");

    // One switch hides an assistant from everyone and stops new requests, and turns it back on.
    const findable = (value: boolean) => api<{ discovery: Array<{ subjectId: string; relayNodeId: string }> }>(a, sa, "PUT", "/social/findable", { subjectKind: "assistant", subjectId: assistantId, findable: value });
    const hidden = await findable(false);
    assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
    assert.equal(hidden.body.discovery.some(item => item.subjectId === assistantId), false);
    const whileHidden = await api<{ results: Result[] }>(b, sb, "GET", "/social/search?q=");
    assert.equal(whileHidden.body.results.some(result => result.kind === "assistant"), false, "a hidden assistant can't be found");
    const refusedThread = await api<{ error: string }>(b, sb, "POST", "/social/threads", { assistantId: listedAssistant.id, nodeId: listedAssistant.nodeId, relayNodeId });
    assert.notEqual(refusedThread.status, 200, "a hidden assistant takes no new requests");
    assert.match(refusedThread.body.error, /isn't taking new requests/);
    assert.equal((await api(a, sa, "PUT", "/social/findable", { subjectKind: "assistant", subjectId: meB.account.accountId, findable: false })).status, 404, "nobody can change someone else's assistant");
    assert.deepEqual((await findable(true)).body.discovery.filter(item => item.subjectId === assistantId).map(item => item.relayNodeId), [relayNodeId], "turning it on lists it on every relay");

    // A direct request without a shared group, approved by the owner, then executed by code.
    const opened = await api<{ threadId: string; catalog: unknown[] }>(b, sb, "POST", "/social/threads", { assistantId: listedAssistant.id, nodeId: listedAssistant.nodeId, relayNodeId });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.equal(opened.body.catalog.length, 2);
    const threadId = opened.body.threadId;
    assert.equal((await api(b, sb, "POST", `/social/threads/${threadId}/messages`, { id: randomUUID(), text: "Can we meet on Thursday at 15:00 for 30 minutes for the vendor review?" })).status, 200);
    type Activity = { approvals: Array<{ id: string; proposalRevision: number; proposal: { reply: string; summary: string } }>; work: Array<{ state: string; text: string; detail: string }>; notices: Array<{ title: string }> };
    const approval = await eventually(async () => {
      const activity = await api<Activity>(a, sa, "GET", `/personal-assistants/${assistantId}/activity`);
      assert.equal(activity.body.approvals.length, 1, JSON.stringify(activity.body));
      return activity.body.approvals[0];
    });
    assert.match(approval.proposal.summary, /Vendor review/);
    const waiting = await api<{ messages: Array<{ author: string; state?: string }> }>(b, sb, "GET", `/social/threads/${threadId}`);
    assert.equal(waiting.body.messages.at(-1)?.state, "awaiting-approval", "the requester sees that the owner is being asked");
    assert.equal(fixture.events.length, 0, "nothing happens before approval");
    assert.equal((await api(a, sa, "POST", `/personal-assistants/${assistantId}/requests/${approval.id}/approve`, { proposalRevision: approval.proposalRevision + 1 })).status, 409, "approval is bound to the exact proposal");
    assert.equal((await api(a, sa, "POST", `/personal-assistants/${assistantId}/requests/${approval.id}/approve`, { proposalRevision: approval.proposalRevision })).status, 200);
    assert.equal((await api(a, sa, "POST", `/personal-assistants/${assistantId}/requests/${approval.id}/approve`, { proposalRevision: approval.proposalRevision })).status, 409, "approval is single use");
    await eventually(async () => {
      const thread = await api<{ messages: Array<{ author: string; text: string }> }>(b, sb, "GET", `/social/threads/${threadId}`);
      assert.match(thread.body.messages.at(-1)?.text ?? "", /^Booked: .*15:00–15:30 \(Vendor review\)\.$/, JSON.stringify(thread.body));
    });
    assert.equal(fixture.events.length, 1);
    assert.equal(fixture.events[0].summary, "Vendor review");
    await api(b, sb, "POST", `/social/threads/${threadId}/messages`, { id: randomUUID(), text: "Can you send me Ilia's notes from last week?" });
    await eventually(async () => {
      const thread = await api<{ messages: Array<{ author: string; text: string }> }>(b, sb, "GET", `/social/threads/${threadId}`);
      assert.match(thread.body.messages.at(-1)?.text ?? "", /doesn't offer that\. You can ask for: Arrange a meeting, Share my travel plan\./);
    });
    assert.equal(fixture.decisions.some(decision => JSON.stringify(decision.state).includes("Help people who ask about my time.")), true, "the decision model receives the owner's instructions");

    // Groups: Ilia creates one; his default assistant joins with him. Noa joins by invitation.
    const group = await api<{ group: { id: string } }>(a, sa, "POST", "/social/groups", { name: "Launch crew", relayNodeId });
    assert.equal(group.status, 201, JSON.stringify(group.body));
    const groupId = group.body.group.id;
    assert.equal((await api(a, sa, "POST", `/social/groups/${groupId}/messages`, { id: randomUUID(), text: "Before Noa joined." })).status, 200);
    const forged = await api(a, sa, "POST", `/social/groups/${groupId}/invitations`, { kind: "person", id: "0123456789abcdef0123456789abcdef", accountId: "0123456789abcdef0123456789abcdef", nodeId: b.nodeId, name: "noa", ownerName: "" });
    assert.equal(forged.status, 400, "an account ID that doesn't derive from the named machine is refused");
    const invited = await api(a, sa, "POST", `/social/groups/${groupId}/invitations`, { kind: "person", id: meB.account.accountId, accountId: meB.account.accountId, nodeId: b.nodeId, name: "noa", ownerName: "" });
    assert.equal(invited.status, 201, JSON.stringify(invited.body));
    const pendingView = await api(b, sb, "GET", `/social/groups/${groupId}`);
    assert.equal(pendingView.status, 404, "a pending invitation grants no transcript access");
    const received = await eventually(async () => {
      const list = await api<{ received: Array<{ id: string; groupName: string; state: string }> }>(b, sb, "GET", "/social/invitations");
      assert.equal(list.body.received[0]?.state, "pending"); return list.body.received[0];
    });
    assert.equal(received.groupName, "Launch crew");
    assert.equal((await api(b, sb, "POST", `/social/invitations/${received.id}/accept`)).status, 200);
    assert.equal((await api(b, sb, "POST", `/social/invitations/${received.id}/accept`)).status, 200, "accepting twice is harmless");
    type Detail = { members: Array<{ membershipId: string; kind: string; name: string; link: string }>; messages: Array<{ text: string; authorName: string; authorKind: string }> };
    const joined = await api<Detail>(b, sb, "GET", `/social/groups/${groupId}`);
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    assert.deepEqual(joined.body.members.map(member => `${member.kind}:${member.name}:${member.link}`), ["person:ilia:", "assistant:Work assistant:with", "person:noa:"], "the companion is a visible member; one membership per person");
    assert.equal(joined.body.messages.some(message => message.text === "Before Noa joined."), false, "new members see messages from their join onward");

    // The member assistant watches: a relevant message reaches the owner privately.
    await api(b, sb, "POST", `/social/groups/${groupId}/messages`, { id: randomUUID(), text: "Finance moved the budget deadline to 12 Nov." });
    await eventually(async () => {
      const activity = await api<Activity>(a, sa, "GET", `/personal-assistants/${assistantId}/activity`);
      assert.ok(activity.body.notices.some(notice => notice.title.includes("budget deadline")), JSON.stringify(activity.body.notices));
    });
    await api(b, sb, "POST", `/social/groups/${groupId}/messages`, { id: randomUUID(), text: "Ilia, can you do 30 minutes on Friday at 11:00 for the launch review?" });
    const groupApproval = await eventually(async () => {
      const activity = await api<Activity>(a, sa, "GET", `/personal-assistants/${assistantId}/activity`);
      assert.equal(activity.body.approvals.length, 1, JSON.stringify(activity.body)); return activity.body.approvals[0];
    });
    assert.equal((await api(a, sa, "POST", `/personal-assistants/${assistantId}/requests/${groupApproval.id}/edit`, { reply: "Booked Friday 11:00 for the launch review." })).status, 200);
    const reapproval = await eventually(async () => {
      const activity = await api<Activity>(a, sa, "GET", `/personal-assistants/${assistantId}/activity`);
      const pending = activity.body.approvals[0];
      assert.ok(pending && pending.proposalRevision > groupApproval.proposalRevision, "an edit is a new proposal, checked again before approval"); return pending;
    });
    assert.equal(reapproval.proposal.reply, "Booked Friday 11:00 for the launch review.");
    assert.equal((await api(a, sa, "POST", `/personal-assistants/${assistantId}/requests/${reapproval.id}/approve`, { proposalRevision: reapproval.proposalRevision })).status, 200);
    await eventually(async () => {
      const detail = await api<Detail>(b, sb, "GET", `/social/groups/${groupId}`);
      const last = detail.body.messages.at(-1)!;
      assert.equal(last.text, "Booked Friday 11:00 for the launch review.", JSON.stringify(detail.body.messages));
      assert.equal(last.authorKind, "assistant"); assert.equal(last.authorName, "Work assistant");
    });
    assert.equal(fixture.events.length, 2);

    // Membership rules: the creator can't remove a companion directly; Noa leaving ends her access.
    // A message that expects Ilia's reply gets a draft. It waits for Ilia, and only the posted text is sent.
    type DraftActivity = { approvals: Array<{ id: string; proposalRevision: number; actionName: string; proposal: { operation: string; reply: string } }>; work: Array<{ state: string; text: string; detail: string }> };
    const nextDraft = () => eventually(async () => {
      const activity = await api<DraftActivity>(a, sa, "GET", `/personal-assistants/${assistantId}/activity`);
      assert.equal(activity.body.approvals.length, 1, JSON.stringify(activity.body));
      return activity.body.approvals[0];
    });
    await api(b, sb, "POST", `/social/groups/${groupId}/messages`, { id: randomUUID(), text: "Ilia, what do you think of the new logo?" });
    const logoDraft = await nextDraft();
    assert.equal(logoDraft.proposal.operation, "reply.text");
    assert.equal(logoDraft.proposal.reply, "Thanks, noa. I like it.");
    const notPosted = await api<Detail>(b, sb, "GET", `/social/groups/${groupId}`);
    assert.equal(notPosted.body.messages.some(message => message.text.includes("I like it")), false, "nothing reaches the group before Ilia posts it");
    const checksBeforeEdit = fixture.decisions.length;
    assert.equal((await api(a, sa, "POST", `/personal-assistants/${assistantId}/requests/${logoDraft.id}/edit`, { reply: "I like the new logo." })).status, 200);
    const editedDraft = await nextDraft();
    assert.equal(editedDraft.proposalRevision, logoDraft.proposalRevision + 1);
    assert.equal(editedDraft.proposal.reply, "I like the new logo.");
    assert.equal(fixture.decisions.length, checksBeforeEdit, "Ilia's own edit needs no decision");
    assert.equal((await api(a, sa, "POST", `/personal-assistants/${assistantId}/requests/${logoDraft.id}/approve`, { proposalRevision: logoDraft.proposalRevision })).status, 409, "a stale version of the draft can't be posted");
    assert.equal((await api(a, sa, "POST", `/personal-assistants/${assistantId}/requests/${logoDraft.id}/approve`, { proposalRevision: editedDraft.proposalRevision })).status, 200);
    await eventually(async () => {
      const detail = await api<Detail>(b, sb, "GET", `/social/groups/${groupId}`);
      assert.ok(detail.body.messages.some(message => message.text === "I like the new logo."), JSON.stringify(detail.body.messages));
    });
    await api(b, sb, "POST", `/social/groups/${groupId}/messages`, { id: randomUUID(), text: "And what do you think of the color?" });
    const unwanted = await nextDraft();
    assert.equal((await api(a, sa, "POST", `/personal-assistants/${assistantId}/requests/${unwanted.id}/reject`)).status, 200);
    const discarded = await api<DraftActivity>(a, sa, "GET", `/personal-assistants/${assistantId}/activity`);
    assert.match(discarded.body.work.find(item => item.text.includes("the color"))?.detail ?? "", /discarded the draft/);
    await api(b, sb, "POST", `/social/threads/${threadId}/messages`, { id: randomUUID(), text: "Ilia, what do you think of Tuesday?" });
    const threadDraft = await nextDraft();
    assert.equal((await api(a, sa, "POST", `/personal-assistants/${assistantId}/requests/${threadDraft.id}/reject`)).status, 200);
    const threadAfter = await api<{ messages: Array<{ text: string }> }>(b, sb, "GET", `/social/threads/${threadId}`);
    assert.equal(threadAfter.body.messages.at(-1)?.text, "Ilia, what do you think of Tuesday?", "discarding a draft sends nothing");
    await rm(draftWriter, { force: true });

    const detailA = await api<Detail>(a, sa, "GET", `/social/groups/${groupId}`);
    const companion = detailA.body.members.find(member => member.kind === "assistant")!;
    assert.equal((await api(a, sa, "POST", `/social/groups/${groupId}/members/${companion.membershipId}/remove`)).status, 409);
    assert.equal((await api(b, sb, "POST", `/social/groups/${groupId}/leave`)).status, 200);
    assert.equal((await api(b, sb, "GET", `/social/groups/${groupId}`)).status, 404, "after leaving, the group is gone from Noa's list");
    const afterLeave = await api<Detail>(a, sa, "GET", `/social/groups/${groupId}`);
    assert.deepEqual(afterLeave.body.members.map(member => member.name), ["ilia", "Work assistant"]);
    assert.equal((await api(a, sa, "POST", `/social/groups/${groupId}/close`)).status, 200);
    assert.equal((await api(a, sa, "POST", `/social/groups/${groupId}/messages`, { id: randomUUID(), text: "After closing" })).status, 404, "a closed group takes no messages");

    // An assistant can be invited on its own: its owner approves and does not join.
    const noasGroup = await api<{ group: { id: string } }>(b, sb, "POST", "/social/groups", { name: "Noa's planning", relayNodeId });
    assert.equal(noasGroup.status, 201, JSON.stringify(noasGroup.body));
    const assistantInvite = await api(b, sb, "POST", `/social/groups/${noasGroup.body.group.id}/invitations`, { kind: "assistant", id: listedAssistant.id, accountId: listedAssistant.ownerAccountId, nodeId: listedAssistant.nodeId, name: "Work assistant", ownerName: "ilia" });
    assert.equal(assistantInvite.status, 201, JSON.stringify(assistantInvite.body));
    const forAssistant = await eventually(async () => {
      const list = await api<{ received: Array<{ id: string; inviteeKind: string; state: string }> }>(a, sa, "GET", "/social/invitations");
      const item = list.body.received.find(entry => entry.inviteeKind === "assistant" && entry.state === "pending");
      assert.ok(item, JSON.stringify(list.body)); return item;
    });
    const approved = await api<{ groupId: string | null; result: string }>(a, sa, "POST", `/social/invitations/${forAssistant.id}/accept`);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.groupId, null, "approving for the assistant doesn't add its owner");
    const noasMembers = await api<Detail>(b, sb, "GET", `/social/groups/${noasGroup.body.group.id}`);
    assert.deepEqual(noasMembers.body.members.map(member => `${member.kind}:${member.name}:${member.link}`), ["person:noa:", "assistant:Work assistant:alone"]);
    assert.equal((await api<{ groups: Array<{ groupId: string }> }>(a, sa, "GET", "/social/groups")).body.groups.some(item => item.groupId === noasGroup.body.group.id), false);

    // Blocking stops new requests immediately.
    assert.equal((await api(a, sa, "POST", "/social/blocks", { accountId: meB.account.accountId, name: "noa", nodeId: b.nodeId })).status, 200);
    assert.equal((await api(b, sb, "POST", `/social/threads/${threadId}/messages`, { id: randomUUID(), text: "Thursday at 16:00?" })).status, 403);
  } finally {
    for (const child of children.reverse()) await stopDevNode(child);
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
