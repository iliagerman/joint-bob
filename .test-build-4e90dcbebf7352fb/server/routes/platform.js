import { getHarnessRuntime, listHarnesses, listHarnessModels } from "../../harnesses.js";
import { addNtfyService, deleteNtfyService, getNtfyService, importNtfyService, listNtfyServices, setDefaultNtfyService, updateNtfyService } from "../../ntfy.js";
import { checkNtfyToken, createNtfyUser, deleteNtfyTopicAccess, deleteNtfyUser, listNtfyTopics, listNtfyUsers, ntfyPermission, ntfySince, ntfyTopicName, ntfyTopicPattern, ntfyUsername, readNtfyMessages, setNtfyTopicAccess } from "../../ntfy-admin.js";
import { isHarnessId } from "../../types.js";
import { deletePushSubscription, getVapidPublicKey, savePushSubscription } from "../../push.js";
import { sendError } from "../http-auth.js";
import { flushPushSubscriptionOutbox } from "../push-flush.js";
import { ntfyServiceSchema, pushSubscribeSchema, pushUnsubscribeSchema, sharedNtfyServiceSchema } from "../schemas.js";
import { app } from "../state.js";
import { getClusterNode } from "../../cluster.js";
import { isTrustedTwin, listSharingClusterMembers, listSharingMemberships } from "../../cluster-sharing-policy.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { forgetNtfyServiceSharing, ntfyServicesSharedWith, ntfyServiceSharingView, setNtfyServiceSharing, shareNtfyServiceNow } from "../ntfy-share.js";
import { z } from "zod";
import { NtfyRequestError, ntfyAgentRequest, ntfyAgentRequestSchema, savedNtfyServer } from "../../ntfy-publish.js";
import { ErrorReportingSettingsError, getErrorReportingSettings, reportError, updateErrorReportingSettings } from "../../error-reporting.js";
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
    const authSession = response.locals.authSession;
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
  const identity = response.locals.ntfyAgent;
  if (!identity) {
    sendError(response, 401, "Unauthorized");
    return;
  }
  try {
    response.json(await ntfyAgentRequest(identity, ntfyAgentRequestSchema.parse(request.body)));
  } catch (error) {
    if (error instanceof NtfyRequestError) {
      sendError(response, error.status, error.message);
      return;
    }
    next(error);
  }
});
app.get("/api/ntfy/services", (_request, response) => {
  response.json({ services: listNtfyServices().map((service) => ({ ...service, sharing: ntfyServiceSharingView(service.id) })) });
});
app.post("/api/ntfy/services", (request, response, next) => {
  try {
    const payload = ntfyServiceSchema.parse(request.body);
    response.status(201).json({ service: addNtfyService(payload.name, payload.url, payload.token ?? "") });
  } catch (error) {
    next(error);
  }
});
app.put("/api/ntfy/services/:id", async (request, response, next) => {
  try {
    const payload = ntfyServiceSchema.partial().parse(request.body);
    const current = getNtfyService(request.params.id);
    if (!current) {
      sendError(response, 404, "ntfy service not found");
      return;
    }
    const account = payload.token ? await checkNtfyToken({ url: (payload.url ?? current.url).replace(/\/+$/, ""), token: payload.token }) : void 0;
    if (account?.status === "rejected") {
      sendError(response, 400, "The ntfy server does not recognize this token (HTTP 401), so it was not saved. Create it on the server with `ntfy token add <admin user>`.");
      return;
    }
    const service = updateNtfyService(request.params.id, payload);
    if (!service) {
      sendError(response, 404, "ntfy service not found");
      return;
    }
    const results = await shareNtfyServiceNow(request.params.id);
    response.json({ service, sharing: ntfyServiceSharingView(request.params.id), results, ...account ? { account } : {} });
  } catch (error) {
    next(error);
  }
});
function ntfyAdminRoute(handler) {
  return async (request, response, next) => {
    try {
      response.json(await handler(request, savedNtfyServer(String(request.params.id))));
    } catch (error) {
      if (error instanceof NtfyRequestError) {
        sendError(response, error.status, error.message);
        return;
      }
      next(error);
    }
  };
}
const ntfyAccessSchema = z.object({ topic: ntfyTopicPattern, username: ntfyUsername, permission: ntfyPermission }).strict();
const ntfyRevokeSchema = z.object({ topic: ntfyTopicPattern, username: ntfyUsername.optional() }).strict();
const ntfyMessagesQuery = z.object({ topic: ntfyTopicName, since: ntfySince.optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).strict();
const ntfyUserSchema = z.object({ username: ntfyUsername.refine((value) => value !== "*"), password: z.string().min(1).max(200), tier: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional() }).strict();
app.get("/api/ntfy/services/:id/topics", ntfyAdminRoute(async (_request, server) => ({ topics: await listNtfyTopics(server) })));
app.put("/api/ntfy/services/:id/topics", ntfyAdminRoute(async (request, server) => {
  const payload = ntfyAccessSchema.parse(request.body);
  return { topic: await setNtfyTopicAccess(server, payload.topic, payload.username, payload.permission) };
}));
app.delete("/api/ntfy/services/:id/topics", ntfyAdminRoute(async (request, server) => {
  const payload = ntfyRevokeSchema.parse(request.body);
  return deleteNtfyTopicAccess(server, payload.topic, payload.username);
}));
app.get("/api/ntfy/services/:id/messages", ntfyAdminRoute(async (request, server) => {
  const query = ntfyMessagesQuery.parse(request.query);
  return { topic: query.topic, messages: await readNtfyMessages(server, query.topic, query.since, query.limit) };
}));
app.get("/api/ntfy/services/:id/users", ntfyAdminRoute(async (_request, server) => ({ users: await listNtfyUsers(server) })));
app.post("/api/ntfy/services/:id/users", ntfyAdminRoute(async (request, server) => {
  const payload = ntfyUserSchema.parse(request.body);
  return createNtfyUser(server, payload.username, payload.password, payload.tier);
}));
app.delete("/api/ntfy/services/:id/users/:username", ntfyAdminRoute(async (request, server) => deleteNtfyUser(server, ntfyUsername.refine((value) => value !== "*").parse(request.params.username))));
app.put("/api/ntfy/services/:id/default", (request, response) => {
  if (!setDefaultNtfyService(request.params.id)) {
    sendError(response, 404, "ntfy service not found");
    return;
  }
  response.json({ ok: true });
});
app.post("/api/ntfy/services/:id/share", async (request, response, next) => {
  try {
    if (!getNtfyService(request.params.id)) {
      sendError(response, 404, "ntfy service not found");
      return;
    }
    const payload = z.object({ includeTwins: z.boolean().default(true), clusterIds: z.array(z.string().uuid()).max(50).default([]) }).strict().parse(request.body ?? {});
    const db = await clusterV2Database(), local = await getClusterNode();
    for (const clusterId of payload.clusterIds) {
      if (!listSharingClusterMembers(db, clusterId).some((member) => member.nodeId === local.id)) {
        sendError(response, 403, "You are not a member of a selected cluster");
        return;
      }
    }
    setNtfyServiceSharing(request.params.id, payload);
    const results = await shareNtfyServiceNow(request.params.id);
    response.json({ sharing: ntfyServiceSharingView(request.params.id), results });
  } catch (error) {
    next(error);
  }
});
app.post("/api/cluster/v2/ntfy/services", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    const db = await clusterV2Database(), local = await getClusterNode();
    const sender = response.locals.machineNodeId;
    const sharesCluster = listSharingMemberships(db, local.id).some(({ clusterId }) => listSharingClusterMembers(db, clusterId).some((member) => member.nodeId === sender));
    if (!isTrustedTwin(db, local.id, sender) && !sharesCluster) {
      sendError(response, 403, "ntfy servers can only be shared between twins or cluster members");
      return;
    }
    response.status(201).json({ service: importNtfyService(sharedNtfyServiceSchema.parse(request.body)) });
  } catch (error) {
    next(error);
  }
});
app.post("/api/cluster/v2/ntfy/services/pull", async (_request, response, next) => {
  try {
    if (!response.locals.machineAuth) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    response.json({ services: await ntfyServicesSharedWith(response.locals.machineNodeId) });
  } catch (error) {
    next(error);
  }
});
app.delete("/api/ntfy/services/:id", (request, response) => {
  if (!deleteNtfyService(request.params.id)) {
    sendError(response, 404, "ntfy service not found");
    return;
  }
  forgetNtfyServiceSharing(request.params.id);
  response.status(204).send();
});
app.get("/api/error-reporting", (_request, response) => {
  response.json(getErrorReportingSettings());
});
app.put("/api/error-reporting", (request, response, next) => {
  try {
    response.json(updateErrorReportingSettings(request.body));
  } catch (error) {
    if (error instanceof ErrorReportingSettingsError) {
      sendError(response, 400, error.message);
      return;
    }
    next(error);
  }
});
const clientErrorSchema = z.object({
  kind: z.enum(["error", "uncaught", "unhandled"]),
  message: z.string().min(1).max(4e3),
  page: z.string().max(500).optional()
}).strict();
app.post("/api/client-errors", (request, response) => {
  const report = clientErrorSchema.parse(request.body);
  const [summary, ...detail] = report.message.split("\n");
  const username = response.locals.authSession?.username ?? "unknown user";
  console.warn(`Client ${report.kind} from ${username}: ${summary}`);
  const userAgent = request.get("user-agent");
  void reportError("client", { summary, detail: [...detail, ...userAgent ? ["", `Browser: ${userAgent}`] : []].join("\n"), source: [report.page, username].filter(Boolean).join(" \xB7 ") });
  response.status(202).send();
});
async function harnessProblems(id) {
  const runtime = await getHarnessRuntime(id);
  const installation = await runtime.readiness(process.cwd());
  return installation.length ? installation : runtime.signInProblems();
}
app.get("/api/harnesses", async (_request, response, next) => {
  try {
    response.json({ harnesses: await Promise.all(listHarnesses().map(async ({ id, label, paths, configuration, defaults, runtime }) => {
      const problems = runtime ? await harnessProblems(id) : ["No runtime on this node"];
      return {
        id,
        label,
        newSessionPath: paths.newSession,
        defaults,
        runtimeConfigured: Boolean(runtime),
        ready: !problems.length,
        ...problems.length ? { unavailableReason: problems.join("\n") } : {},
        ...configuration ? { configuration: { fixedProvider: configuration.fixedProvider, thinkingLevels: configuration.thinkingLevels } } : {}
      };
    })) });
  } catch (error) {
    next(error);
  }
});
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
    if (raw !== void 0 && (typeof raw !== "string" || !isHarnessId(raw) || !listHarnesses().some(({ id }) => id === raw))) {
      response.status(400).json({ error: "Unknown harness" });
      return;
    }
    const adapters = raw ? listHarnesses().filter(({ id }) => id === raw) : listHarnesses();
    const groups = await Promise.all(adapters.filter(({ models }) => models).map(async ({ id }) => (await listHarnessModels(id)).map((model) => ({ ...model, harnessId: id }))));
    response.json({ models: groups.flat() });
  } catch (error) {
    next(error);
  }
});
