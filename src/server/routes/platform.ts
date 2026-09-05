import type { AuthSession } from "../../auth.js";
import { listHarnesses } from "../../harnesses.js";
import { listAvailableModels } from "../../pi-service.js";
import { deletePushSubscription, getVapidPublicKey, savePushSubscription } from "../../push.js";
import { pushSubscribeSchema, pushUnsubscribeSchema } from "../schemas.js";
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
    await savePushSubscription(payload.subscription, authSession.userId, payload.projectId, payload.sessionPath, payload.title || "Pi");
    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.post("/api/push/unsubscribe", async (request, response, next) => {
  try {
    const payload = pushUnsubscribeSchema.parse(request.body);
    await deletePushSubscription(payload.endpoint);
    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.get("/api/harnesses", (_request, response) => {
  response.json({ harnesses: listHarnesses().map(({ id, label, paths }) => ({ id, label, newSessionPath: paths.newSession })) });
});

app.get("/api/models", async (_request, response, next) => {
  try {
    response.json({ models: await listAvailableModels() });
  } catch (error) {
    next(error);
  }
});
