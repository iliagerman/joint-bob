import type { AuthSession } from "../../auth.js";
import { getHarnessRuntime, listHarnesses } from "../../harnesses.js";
import { addNtfyService, deleteNtfyService, listNtfyServices } from "../../ntfy.js";
import { isHarnessId } from "../../types.js";
import { deletePushSubscription, getVapidPublicKey, savePushSubscription } from "../../push.js";
import { sendError } from "../http-auth.js";
import { flushPushSubscriptionOutbox } from "../push-flush.js";
import { ntfyServiceSchema, pushSubscribeSchema, pushUnsubscribeSchema } from "../schemas.js";
import { app } from "../state.js";

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
    await savePushSubscription(payload.subscription, authSession.userId, payload.projectId, payload.sessionPath, payload.title || "Conversation");
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

app.delete("/api/ntfy/services/:id", (request, response) => {
  if (!deleteNtfyService(request.params.id)) {
    sendError(response, 404, "ntfy service not found");
    return;
  }
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
