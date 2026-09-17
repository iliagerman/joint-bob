import type { AuthSession } from "../../auth.js";
import { getHarnessRuntime, listHarnesses } from "../../harnesses.js";
import { addNtfyService, deleteNtfyService, getNtfyService, importNtfyService, listNtfyServices, setDefaultNtfyService } from "../../ntfy.js";
import { listClusterPeers } from "../../cluster.js";
import { isHarnessId } from "../../types.js";
import { deletePushSubscription, getVapidPublicKey, savePushSubscription } from "../../push.js";
import { sendError } from "../http-auth.js";
import { flushPushSubscriptionOutbox } from "../push-flush.js";
import { ntfyServiceSchema, pushSubscribeSchema, pushUnsubscribeSchema, sharedNtfyServiceSchema } from "../schemas.js";
import { app } from "../state.js";
import type { AgentCapabilityIdentity } from "../../agent-capabilities.js";
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

app.post("/api/ntfy/services/:id/share", async (request, response, next) => {
  try {
    const service = getNtfyService(request.params.id);
    if (!service) { sendError(response, 404, "ntfy service not found"); return; }
    const results = await Promise.all((await listClusterPeers()).map(async (peer) => {
      try {
        const shared = await fetch(`${peer.url}/api/cluster/ntfy/services`, { method: "POST", headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" }, body: JSON.stringify(service), signal: AbortSignal.timeout(10_000) });
        if (!shared.ok) throw new Error(`HTTP ${shared.status}`);
        await shared.body?.cancel();
        return { peerId: peer.id, ok: true };
      } catch (error) {
        return { peerId: peer.id, ok: false, error: error instanceof Error ? error.message : "Share failed" };
      }
    }));
    response.json({ results });
  } catch (error) { next(error); }
});

app.post("/api/cluster/ntfy/services", (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    response.status(201).json({ service: importNtfyService(sharedNtfyServiceSchema.parse(request.body)) });
  } catch (error) { next(error); }
});

app.delete("/api/ntfy/services/:id", (request, response) => {
  if (!deleteNtfyService(request.params.id)) { sendError(response, 404, "ntfy service not found"); return; }
  response.status(204).send();
});

app.get("/api/harnesses", (_request, response) => {
  response.json({ harnesses: listHarnesses().map(({ id, label, paths, configuration, defaults, runtime }) => ({
    id, label, newSessionPath: paths.newSession, defaults, runtimeConfigured: Boolean(runtime),
    ...(configuration ? { configuration: { fixedProvider: configuration.fixedProvider, thinkingLevels: configuration.thinkingLevels } } : {}),
  })) });
});

app.get("/api/models", async (request, response, next) => {
  try {
    const raw = request.query.harnessId;
    if (raw !== undefined && (typeof raw !== "string" || !isHarnessId(raw) || !listHarnesses().some(({ id }) => id === raw))) {
      response.status(400).json({ error: "Unknown harness" });
      return;
    }
    const adapters = raw ? listHarnesses().filter(({ id }) => id === raw) : listHarnesses();
    const groups = await Promise.all(adapters.filter(({ runtime }) => runtime).map(async ({ id }) =>
      (await getHarnessRuntime(id).then((runtime) => runtime.models())).map((model) => ({ ...model, harnessId: id }))));
    response.json({ models: groups.flat() });
  } catch (error) {
    next(error);
  }
});
