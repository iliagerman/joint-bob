import type { AuthSession } from "../../auth.js";
import { getHarnessRuntime, listHarnesses, listHarnessModels } from "../../harnesses.js";
import { addNtfyService, deleteNtfyService, getNtfyService, importNtfyService, listNtfyServices, setDefaultNtfyService } from "../../ntfy.js";
import { isHarnessId, type HarnessId } from "../../types.js";
import { deletePushSubscription, getVapidPublicKey, savePushSubscription } from "../../push.js";
import { sendError } from "../http-auth.js";
import { flushPushSubscriptionOutbox } from "../push-flush.js";
import { ntfyServiceSchema, pushSubscribeSchema, pushUnsubscribeSchema, sharedNtfyServiceSchema } from "../schemas.js";
import { app } from "../state.js";
import { getClusterNode } from "../../cluster.js";
import { isTrustedTwin, listSharingClusterMembers, listSharingMemberships } from "../../cluster-sharing-policy.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { replicationPeers, signedPeerPost } from "../replication-v2.js";
import type { AgentCapabilityIdentity } from "../../agent-capabilities.js";
import { z } from "zod";
import { NtfyRequestError, ntfyAgentRequest, ntfyAgentRequestSchema } from "../../ntfy-publish.js";

app.get("/api/push/vapid-public-key", async (_request, response, next) => {
  try {
    response.json({ publicKey: await getVapidPublicKey() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/push/subscribe", async (request, response, next) => {
  try {
    const payload = pushSubscribeSchema.parse(request.body);
    const authSession = response.locals.authSession as AuthSession;
    await savePushSubscription(payload.subscription, authSession.userId, payload.projectId, payload.sessionPath, payload.title || "Conversation", authSession.username.toLowerCase());
    flushPushSubscriptionOutbox().catch((error) => console.warn("Push subscription flush failed", error));
    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.post("/api/push/unsubscribe", async (request, response, next) => {
  try {
    const payload = pushUnsubscribeSchema.parse(request.body);
    await deletePushSubscription(payload.endpoint);
    flushPushSubscriptionOutbox().catch((error) => console.warn("Push subscription flush failed", error));
    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.post("/api/ntfy/agent", async (request, response, next) => {
  const identity = response.locals.ntfyAgent as AgentCapabilityIdentity | undefined;
  if (!identity) { sendError(response, 401, "Unauthorized"); return; }
  try {
    response.json(await ntfyAgentRequest(identity, ntfyAgentRequestSchema.parse(request.body)));
  } catch (error) {
    if (error instanceof NtfyRequestError) { sendError(response, error.status, error.message); return; }
    next(error);
  }
});

app.get("/api/ntfy/services", (_request, response) => {
  response.json({ services: listNtfyServices() });
});

app.post("/api/ntfy/services", (request, response, next) => {
  try {
    const payload = ntfyServiceSchema.parse(request.body);
    response.status(201).json({ service: addNtfyService(payload.name, payload.url, payload.token ?? "") });
  } catch (error) {
    next(error);
  }
});

app.put("/api/ntfy/services/:id/default", (request, response) => {
  if (!setDefaultNtfyService(request.params.id)) { sendError(response, 404, "ntfy service not found"); return; }
  response.json({ ok: true });
});

/** Shares ntfy credentials only to explicitly selected twins or cluster members. */
app.post("/api/ntfy/services/:id/share", async (request, response, next) => {
  try {
    const service = getNtfyService(request.params.id);
    if (!service) { sendError(response, 404, "ntfy service not found"); return; }
    const payload = z.object({ includeTwins: z.boolean().default(true), clusterIds: z.array(z.string().uuid()).max(50).default([]) }).strict().parse(request.body ?? {});
    const db = await clusterV2Database(), local = await getClusterNode();
    const peers = replicationPeers(db, local.id);
    const targets = new Set(peers.filter((peer) => payload.includeTwins && isTrustedTwin(db, local.id, peer.nodeId)).map((peer) => peer.nodeId));
    for (const clusterId of payload.clusterIds) {
      const members = listSharingClusterMembers(db, clusterId);
      if (!members.some((member) => member.nodeId === local.id)) { sendError(response, 403, "You are not a member of a selected cluster"); return; }
      for (const member of members) if (member.nodeId !== local.id && peers.some((peer) => peer.nodeId === member.nodeId)) targets.add(member.nodeId);
    }
    const results = await Promise.all([...targets].map(async (peerId) => {
      const peer = peers.find(({ nodeId }) => nodeId === peerId)!;
      try {
        await signedPeerPost(peer, "/api/cluster/v2/ntfy/services", service);
        return { peerId, ok: true };
      } catch (error) {
        return { peerId, ok: false, error: error instanceof Error ? error.message : "Share failed" };
      }
    }));
    response.json({ results });
  } catch (error) { next(error); }
});

app.post("/api/cluster/v2/ntfy/services", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const db = await clusterV2Database(), local = await getClusterNode();
    const sender = response.locals.machineNodeId as string;
    const sharesCluster = listSharingMemberships(db, local.id).some(({ clusterId }) =>
      listSharingClusterMembers(db, clusterId).some((member) => member.nodeId === sender));
    if (!isTrustedTwin(db, local.id, sender) && !sharesCluster) { sendError(response, 403, "ntfy servers can only be shared between twins or cluster members"); return; }
    response.status(201).json({ service: importNtfyService(sharedNtfyServiceSchema.parse(request.body)) });
  } catch (error) { next(error); }
});

app.delete("/api/ntfy/services/:id", (request, response) => {
  if (!deleteNtfyService(request.params.id)) { sendError(response, 404, "ntfy service not found"); return; }
  response.status(204).send();
});

async function harnessProblems(id: HarnessId): Promise<string[]> {
  const runtime = await getHarnessRuntime(id);
  const installation = await runtime.readiness(process.cwd());
  return installation.length ? installation : runtime.signInProblems();
}

// `ready` means installed and signed in on this node; the UI offers only ready harnesses for new work.
app.get("/api/harnesses", async (_request, response, next) => {
  try {
    response.json({ harnesses: await Promise.all(listHarnesses().map(async ({ id, label, paths, configuration, defaults, runtime }) => {
      const problems = runtime ? await harnessProblems(id) : ["No runtime on this node"];
      return {
        id, label, newSessionPath: paths.newSession, defaults, runtimeConfigured: Boolean(runtime),
        ready: !problems.length, ...(problems.length ? { unavailableReason: problems.join("\n") } : {}),
        ...(configuration ? { configuration: { fixedProvider: configuration.fixedProvider, thinkingLevels: configuration.thinkingLevels } } : {}),
      };
    })) });
  } catch (error) {
    next(error);
  }
});

// The providers and models a harness can use on this node, for the Settings pickers.
app.get("/api/harnesses/:id/model-options", async (request, response, next) => {
  try {
    const id = request.params.id;
    if (!isHarnessId(id) || !listHarnesses().some((adapter) => adapter.id === id && adapter.runtime)) {
      response.status(404).json({ error: "Unknown harness" });
      return;
    }
    const runtime = await getHarnessRuntime(id);
    const [providers, models] = await Promise.all([runtime.providers(), listHarnessModels(id)]);
    response.json({ providers, models });
  } catch (error) {
    next(error);
  }
});

app.get("/api/models", async (request, response, next) => {
  try {
    const raw = request.query.harnessId;
    if (raw !== undefined && (typeof raw !== "string" || !isHarnessId(raw) || !listHarnesses().some(({ id }) => id === raw))) {
      response.status(400).json({ error: "Unknown harness" });
      return;
    }
    const adapters = raw ? listHarnesses().filter(({ id }) => id === raw) : listHarnesses();
    const groups = await Promise.all(adapters.filter(({ models }) => models).map(async ({ id }) =>
      (await listHarnessModels(id)).map((model) => ({ ...model, harnessId: id }))));
    response.json({ models: groups.flat() });
  } catch (error) {
    next(error);
  }
});
