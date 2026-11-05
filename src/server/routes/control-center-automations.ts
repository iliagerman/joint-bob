import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { AuthSession } from "../../auth.js";
import {
  AutomationError, createReport, createScheduledTask, createWebhookCompact, deleteAutomation, listAutomations, reportChangeSchema, reportInputSchema, scheduledTaskChangeSchema,
  scheduledTaskInputSchema, setAutomationEnabled, updateReport, updateScheduledTask, updateWebhookCompact, webhookChangeSchema, webhookInputCompactSchema,
} from "../control-center-automations.js";
import "../control-center-automation-chat.js";
import { sendReportNow, startBobReports } from "../control-center-reports.js";
import { sendError } from "../http-auth.js";
import { app, server } from "../state.js";

const session = (response: Response): AuthSession => response.locals.authSession as AuthSession;
const kindSchema = z.enum(["schedule", "webhook", "bob"]);
const idSchema = z.string().min(1).max(100);
const enabledSchema = z.object({ enabled: z.boolean() }).strict();

/** Runs one route. A refusal the person can act on keeps its status and words; anything else goes to the usual error handler. */
function route(work: (request: Request, response: Response) => Promise<void>) {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try { await work(request, response); } catch (error) {
      if (error instanceof AutomationError) { sendError(response, error.status, error.message); return; }
      // A refused value is not echoed back: it may be an id the person has no right to know.
      if (error instanceof z.ZodError) { sendError(response, 400, "Invalid automation request"); return; }
      next(error);
    }
  };
}

/** Every scheduled task, webhook and Bob report the person can see, in one list. */
app.get("/api/control-center/automations", route(async (_request, response) => {
  response.json(await listAutomations(session(response)));
}));

app.put("/api/control-center/automations/:kind/:id/enabled", route(async (request, response) => {
  const { enabled } = enabledSchema.parse(request.body);
  response.json({ row: await setAutomationEnabled(session(response), kindSchema.parse(request.params.kind), idSchema.parse(request.params.id), enabled) });
}));

app.delete("/api/control-center/automations/:kind/:id", route(async (request, response) => {
  response.json({ deleted: await deleteAutomation(session(response), kindSchema.parse(request.params.kind), idSchema.parse(request.params.id)) });
}));

app.post("/api/control-center/automations/schedule", route(async (request, response) => {
  response.status(201).json({ task: await createScheduledTask(session(response), scheduledTaskInputSchema.parse(request.body)) });
}));
app.put("/api/control-center/automations/schedule/:id", route(async (request, response) => {
  await updateScheduledTask(session(response), idSchema.parse(request.params.id), scheduledTaskChangeSchema.parse(request.body));
  response.json({ ok: true });
}));

/** The reply carries the webhook's secret address once, as the Webhooks settings do. */
app.post("/api/control-center/automations/webhook", route(async (request, response) => {
  response.status(201).json(await createWebhookCompact(session(response), webhookInputCompactSchema.parse(request.body)));
}));
app.put("/api/control-center/automations/webhook/:id", route(async (request, response) => {
  await updateWebhookCompact(session(response), idSchema.parse(request.params.id), webhookChangeSchema.parse(request.body));
  response.json({ ok: true });
}));

app.post("/api/control-center/automations/bob", route(async (request, response) => {
  response.status(201).json({ schedule: await createReport(session(response), reportInputSchema.parse(request.body)) });
}));
app.put("/api/control-center/automations/bob/:id", route(async (request, response) => {
  response.json({ schedule: await updateReport(session(response), idSchema.parse(request.params.id), reportChangeSchema.parse(request.body)) });
}));
app.post("/api/control-center/automations/bob/:id/send", route(async (request, response) => {
  response.json({ message: await sendReportNow(session(response), idSchema.parse(request.params.id)) });
}));

// Bob's reports run on one timer that starts when the server starts listening, the way the nightly knowledge cleanup does.
server.once("listening", startBobReports);
