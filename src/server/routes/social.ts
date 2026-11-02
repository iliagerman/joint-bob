import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { AuthSession } from "../../auth.js";
import { getClusterNode } from "../../cluster.js";
import { getPersonalAssistant, listPersonalAssistants, type PersonalAssistant } from "../../personal-assistants.js";
import { projectVisible } from "../../store.js";
import { actionInputSchema, createAction, deleteAction, getAction, listActions, publishProblem, setActionStatus, updateAction } from "../../social/actions.js";
import { block, discoverySettings, listBlocks, localListings, personName, searchDirectory, setDefaultAssistant, setDiscovery, setSocialLimits, socialProfile, unblock } from "../../social/directory.js";
import { onSocialChange } from "../../social/events.js";
import { assistantGroups, closeGroup, createGroup, groupDetail, hostOps, inviteToGroup, leaveGroup, listGroups, listInvitations, memberOps, removeFromGroup, respondToInvitation, revokeInvitation, sendToGroup, type HostOperation } from "../../social/groups.js";
import { SocialPeerError, sharesRelay, socialMachineRoute, socialRelays } from "../../social/network.js";
import { approveRequest, editRequestReply, listActivity, markNoticeRead, recoverInterruptedRequests, rejectRequest, resolveUncertainRequest, testAction } from "../../social/requests.js";
import { listThreads, openThread, sendInThread, threadDetail, threadHostOps, threadMemberOps, type ThreadHostOperation } from "../../social/threads.js";
import { sendError } from "../http-auth.js";
import { app } from "../state.js";

void recoverInterruptedRequests().catch(error => console.error("Social: could not mark interrupted requests:", error));

const uuid = z.string().uuid();

// ---- Machine endpoints. Each handler authorizes its own operation and account. ----

app.post("/api/cluster/v2/social/directory/search", socialMachineRoute(async (body, sender) => {
  const input = z.object({ relayNodeId: uuid, query: z.string().max(200), kind: z.enum(["all", "person", "assistant"]) }).strict().parse(body);
  if (!await sharesRelay(sender, input.relayNodeId)) throw new SocialPeerError("Listings are only shared on a relay both machines are on", 403);
  return { listings: await localListings(input.relayNodeId, input.query, input.kind) };
}));
app.post("/api/cluster/v2/social/groups/changed", socialMachineRoute((body, sender) => memberOps.changed(body, sender)));
app.post("/api/cluster/v2/social/invitations/deliver", socialMachineRoute((body, sender) => memberOps.deliver(body, sender)));
app.post("/api/cluster/v2/social/invitations/changed", socialMachineRoute((body, sender) => memberOps.invitationChanged(body, sender)));
app.post("/api/cluster/v2/social/threads/changed", socialMachineRoute((body, sender) => threadMemberOps.changed(body, sender)));
app.post("/api/cluster/v2/social/groups/:operation", (request, response, next) => {
  const operation = request.params.operation as HostOperation;
  if (!Object.hasOwn(hostOps, operation)) { sendError(response, 404, "Not found"); return; }
  socialMachineRoute((body, sender) => hostOps[operation](body, sender))(request, response, next);
});
app.post("/api/cluster/v2/social/threads/:operation", (request, response, next) => {
  const operation = request.params.operation as ThreadHostOperation;
  if (!Object.hasOwn(threadHostOps, operation)) { sendError(response, 404, "Not found"); return; }
  socialMachineRoute((body, sender) => threadHostOps[operation](body, sender))(request, response, next);
});

// ---- The signed-in person. ----

const session = (response: Response) => response.locals.authSession as AuthSession;
function personal(handler: (request: Request, response: Response, accountId: string) => Promise<unknown>) {
  return (request: Request, response: Response, next: NextFunction): void => {
    handler(request, response, session(response).accountId).then(body => { if (!response.headersSent) { if (body === undefined) response.status(204).end(); else response.json(body); } }).catch(error => {
      if (error instanceof SocialPeerError) { sendError(response, error.status, error.message); return; }
      if (error instanceof z.ZodError) { sendError(response, 400, error.issues[0]?.message ?? "Invalid request"); return; }
      next(error);
    });
  };
}

app.get("/api/social/me", personal(async (_request, _response, accountId) => {
  const [relays, profile, discovery, blocks, assistants, groups] = await Promise.all([socialRelays(), socialProfile(accountId), discoverySettings(accountId), listBlocks(accountId), listPersonalAssistants(accountId), listGroups(accountId)]);
  const local = await getClusterNode();
  return {
    account: { accountId, name: personName(accountId) ?? "", nodeId: local.id, nodeName: local.name },
    relays: relays.map(relay => ({ relayNodeId: relay.relayNodeId, name: relay.name, active: relay.active })),
    profile, discovery, blocks,
    assistants: assistants.map(assistant => ({ id: assistant.id, name: assistant.name, nodeId: assistant.nodeId || local.id, local: !assistant.nodeId || assistant.nodeId === local.id })),
    groups: groups.map(group => ({ groupId: group.groupId, name: group.name, relayNodeId: group.relayNodeId, companionName: group.companionName })),
  };
}));
app.put("/api/social/discovery", personal(async (request, _response, accountId) => {
  await setDiscovery(accountId, z.object({ subjectKind: z.enum(["person", "assistant"]), subjectId: z.string().min(1).max(200), relayNodeId: uuid, enabled: z.boolean() }).strict().parse(request.body));
  return { discovery: await discoverySettings(accountId) };
}));
app.put("/api/social/default-assistant", personal(async (request, _response, accountId) => ({ profile: await setDefaultAssistant(accountId, z.object({ assistantId: uuid.nullable() }).strict().parse(request.body).assistantId) })));
app.put("/api/social/profile", personal(async (request, _response, accountId) => ({
  profile: await setSocialLimits(accountId, z.object({ requestLimit: z.number().int().min(1).max(1000), decisionLimit: z.number().int().min(1).max(10000), description: z.string().trim().max(300) }).strict().parse(request.body)),
})));
app.post("/api/social/blocks", personal(async (request, _response, accountId) => {
  const target = z.object({ accountId: z.string().min(1).max(200), name: z.string().trim().min(1).max(100), nodeId: z.string().max(200) }).strict().parse(request.body);
  if (target.accountId === accountId) throw new SocialPeerError("You can't block yourself", 400);
  await block(accountId, target);
  return { blocks: await listBlocks(accountId) };
}));
app.delete("/api/social/blocks/:accountId", personal(async (request, _response, accountId) => {
  if (!await unblock(accountId, request.params.accountId)) throw new SocialPeerError("Not blocked", 404);
  return { blocks: await listBlocks(accountId) };
}));
app.get("/api/social/search", personal(async (request, _response, accountId) => {
  const query = z.object({ q: z.string().max(200).default(""), kind: z.enum(["all", "person", "assistant"]).default("all") }).parse(request.query);
  return searchDirectory(accountId, query.q.trim(), query.kind);
}));

app.get("/api/social/groups", personal(async (_request, _response, accountId) => ({ groups: await listGroups(accountId) })));
app.post("/api/social/groups", personal(async (request, response, accountId) => {
  const input = z.object({ name: z.string().trim().min(1).max(100), relayNodeId: uuid }).strict().parse(request.body);
  response.status(201);
  return { group: await createGroup(accountId, input) };
}));
app.get("/api/social/groups/:id", personal(async (request, _response, accountId) => groupDetail(accountId, uuid.parse(request.params.id))));
app.post("/api/social/groups/:id/messages", personal(async (request, _response, accountId) => {
  const input = z.object({ id: uuid, text: z.string().trim().min(1).max(8000) }).strict().parse(request.body);
  return { message: await sendToGroup(accountId, uuid.parse(request.params.id), input.id, input.text) };
}));
app.post("/api/social/groups/:id/invitations", personal(async (request, response, accountId) => {
  const invitee = z.object({ kind: z.enum(["person", "assistant"]), id: z.string().min(1).max(200), accountId: z.string().min(1).max(200), nodeId: uuid, name: z.string().trim().min(1).max(100), ownerName: z.string().max(100) }).strict().parse(request.body);
  response.status(201);
  return inviteToGroup(accountId, uuid.parse(request.params.id), invitee);
}));
app.post("/api/social/groups/:id/leave", personal(async (request, _response, accountId) => leaveGroup(accountId, uuid.parse(request.params.id))));
app.post("/api/social/groups/:id/close", personal(async (request, _response, accountId) => closeGroup(accountId, uuid.parse(request.params.id))));
app.post("/api/social/groups/:id/members/:membershipId/remove", personal(async (request, _response, accountId) => removeFromGroup(accountId, uuid.parse(request.params.id), uuid.parse(request.params.membershipId))));

app.get("/api/social/invitations", personal(async (_request, _response, accountId) => listInvitations(accountId)));
app.post("/api/social/invitations/:id/accept", personal(async (request, _response, accountId) => respondToInvitation(accountId, uuid.parse(request.params.id), true)));
app.post("/api/social/invitations/:id/decline", personal(async (request, _response, accountId) => respondToInvitation(accountId, uuid.parse(request.params.id), false)));
app.post("/api/social/invitations/:id/revoke", personal(async (request, _response, accountId) => revokeInvitation(accountId, uuid.parse(request.params.id))));

app.get("/api/social/threads", personal(async (_request, _response, accountId) => ({ threads: await listThreads(accountId) })));
app.post("/api/social/threads", personal(async (request, _response, accountId) => openThread(accountId, z.object({ assistantId: uuid, nodeId: uuid, relayNodeId: z.string().max(200) }).strict().parse(request.body))));
app.get("/api/social/threads/:id", personal(async (request, _response, accountId) => threadDetail(accountId, uuid.parse(request.params.id))));
app.post("/api/social/threads/:id/messages", personal(async (request, _response, accountId) => {
  const input = z.object({ id: uuid, text: z.string().trim().min(1).max(4000) }).strict().parse(request.body);
  return sendInThread(accountId, uuid.parse(request.params.id), input.id, input.text);
}));

/** Live change signals for this person's pages: ids only, never content. */
app.get("/api/social/events", (request, response) => {
  const accountId = session(response).accountId;
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  response.write(": connected\n\n");
  const stop = onSocialChange(change => {
    if (!change.accountIds.includes(accountId)) return;
    const { accountIds: _accounts, ...visible } = change;
    response.write(`data: ${JSON.stringify(visible)}\n\n`);
  });
  const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 25_000);
  request.on("close", () => { stop(); clearInterval(keepAlive); });
});

// ---- The owner of an assistant, on its execution machine. ----

async function ownedAssistant(response: Response, id: string): Promise<PersonalAssistant> {
  const entry = await getPersonalAssistant(session(response).accountId, id);
  if (!entry || !await projectVisible(entry.projectId)) throw new SocialPeerError("Assistant not found", 404);
  const local = await getClusterNode();
  if (entry.nodeId && entry.nodeId !== local.id) throw new SocialPeerError("Open this assistant on its execution machine to manage its public work", 409);
  return entry;
}

app.get("/api/personal-assistants/:id/actions", personal(async (request, response) => {
  const assistant = await ownedAssistant(response, request.params.id);
  return { actions: (await listActions(assistant.id)).map(action => ({ ...action, problem: publishProblem(action) })) };
}));
app.post("/api/personal-assistants/:id/actions", personal(async (request, response) => {
  const assistant = await ownedAssistant(response, request.params.id);
  response.status(201);
  return { action: await createAction(assistant.id, actionInputSchema.parse(request.body)) };
}));
app.put("/api/personal-assistants/:id/actions/:actionId", personal(async (request, response) => {
  const assistant = await ownedAssistant(response, request.params.id);
  return { action: await updateAction(assistant.id, uuid.parse(request.params.actionId), actionInputSchema.parse(request.body)) };
}));
app.post("/api/personal-assistants/:id/actions/:actionId/status", personal(async (request, response) => {
  const assistant = await ownedAssistant(response, request.params.id);
  return { action: await setActionStatus(assistant.id, uuid.parse(request.params.actionId), z.object({ status: z.enum(["published", "disabled"]) }).strict().parse(request.body).status) };
}));
app.delete("/api/personal-assistants/:id/actions/:actionId", personal(async (request, response) => {
  const assistant = await ownedAssistant(response, request.params.id);
  await deleteAction(assistant.id, uuid.parse(request.params.actionId));
  return undefined;
}));
app.post("/api/personal-assistants/:id/actions/:actionId/test", personal(async (request, response) => {
  const assistant = await ownedAssistant(response, request.params.id);
  const input = z.object({ callerName: z.string().trim().min(1).max(100), text: z.string().trim().min(1).max(4000) }).strict().parse(request.body);
  await getAction(assistant.id, uuid.parse(request.params.actionId));
  return testAction(assistant, request.params.actionId, input);
}));

app.get("/api/personal-assistants/:id/activity", personal(async (request, response) => {
  const assistant = await ownedAssistant(response, request.params.id);
  return { ...await listActivity(assistant.id), groups: await assistantGroups(assistant.id) };
}));
app.post("/api/personal-assistants/:id/requests/:requestId/approve", personal(async (request, response) => {
  const assistant = await ownedAssistant(response, request.params.id);
  await approveRequest(assistant, uuid.parse(request.params.requestId), z.object({ proposalRevision: z.number().int().min(1) }).strict().parse(request.body).proposalRevision);
  return { ok: true };
}));
app.post("/api/personal-assistants/:id/requests/:requestId/reject", personal(async (request, response) => {
  await rejectRequest(await ownedAssistant(response, request.params.id), uuid.parse(request.params.requestId));
  return { ok: true };
}));
app.post("/api/personal-assistants/:id/requests/:requestId/edit", personal(async (request, response) => {
  const assistant = await ownedAssistant(response, request.params.id);
  await editRequestReply(assistant, uuid.parse(request.params.requestId), z.object({ reply: z.string().trim().min(1).max(4000) }).strict().parse(request.body).reply);
  return { ok: true };
}));
app.post("/api/personal-assistants/:id/requests/:requestId/resolve", personal(async (request, response) => {
  const assistant = await ownedAssistant(response, request.params.id);
  await resolveUncertainRequest(assistant, uuid.parse(request.params.requestId), z.object({ created: z.boolean() }).strict().parse(request.body).created);
  return { ok: true };
}));
app.post("/api/personal-assistants/:id/notices/:noticeId/read", personal(async (request, response) => {
  const assistant = await ownedAssistant(response, request.params.id);
  if (!await markNoticeRead(assistant, uuid.parse(request.params.noticeId))) throw new SocialPeerError("Notice not found", 404);
  return { ok: true };
}));
