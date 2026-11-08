import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { AuthSession } from "../../auth.js";
import { triageQuestion } from "../../control-center/triggers-brief.js";
import { dismissTriggers, getTrigger, listTriggers, markTriggersSeen, publicTrigger, type Trigger } from "../../control-center/triggers-store.js";
import { projectVisible } from "../../store.js";
import { isBeingRated, rearmSnoozeTimer, startAlertSweep, triggerDatabase } from "../control-center-triggers.js";
import { startOutcomeChecks } from "../control-center-outcomes.js";
import { sendError } from "../http-auth.js";
import { broadcastToAllClients } from "../realtime.js";
import { app, server } from "../state.js";

// Incoming triggers: what webhooks received, rated urgent or not. The urgent ones are in Bob's chat; these routes serve the bell.

const listQuery = z.object({
  filter: z.enum(["bell", "urgent", "all"]).default("bell"),
  page: z.coerce.number().int().min(1).max(1_000).default(1),
  size: z.coerce.number().int().min(1).max(50).default(10),
}).strict();
const ids = z.array(z.string().min(1).max(100)).min(1).max(200);
const seenBody = z.object({ ids }).strict();
const dismissBody = z.union([z.object({ ids }).strict(), z.object({ all: z.literal(true) }).strict()]);

const accountOf = (response: Response): string => (response.locals.authSession as AuthSession).accountId;

function route(work: (request: Request, response: Response) => Promise<void>) {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try { await work(request, response); } catch (error) {
      if (error instanceof z.ZodError) { sendError(response, 400, "Invalid request for incoming triggers"); return; }
      next(error);
    }
  };
}

/** What this person can still see: triggers whose rating is in and whose project they can still open. */
async function listed(accountId: string, filter: "bell" | "urgent" | "all"): Promise<Trigger[]> {
  const found = listTriggers(await triggerDatabase(), accountId, filter).filter((trigger) => !isBeingRated(trigger.id));
  const visible = new Map<string, boolean>();
  for (const projectId of new Set(found.map((trigger) => trigger.projectId))) visible.set(projectId, await projectVisible(projectId));
  return found.filter((trigger) => visible.get(trigger.projectId));
}

/** One page of the list, and how many in the bell are new (the number on the bell). */
app.get("/api/control-center/triggers", route(async (request, response) => {
  const query = listQuery.parse(request.query);
  const accountId = accountOf(response);
  const found = await listed(accountId, query.filter);
  const bell = query.filter === "bell" ? found : await listed(accountId, "bell");
  response.json({
    triggers: found.slice((query.page - 1) * query.size, query.page * query.size).map(publicTrigger),
    total: found.length,
    newCount: bell.filter((trigger) => trigger.state === "new").length,
  });
}));

/** What the person says to Bob to have it triage one trigger. The page sends it through Bob's chat like anything they type. */
app.get("/api/control-center/triggers/:id/triage", route(async (request, response) => {
  const accountId = accountOf(response);
  const trigger = getTrigger(await triggerDatabase(), accountId, z.string().min(1).max(100).parse(request.params.id));
  if (!trigger || trigger.state === "dismissed" || !await projectVisible(trigger.projectId)) { sendError(response, 404, "That trigger is no longer there"); return; }
  response.json({ message: triageQuestion(trigger), projectId: trigger.projectId });
}));

app.post("/api/control-center/triggers/seen", route(async (request, response) => {
  const accountId = accountOf(response);
  const marked = markTriggersSeen(await triggerDatabase(), accountId, seenBody.parse(request.body).ids);
  if (marked) broadcastToAllClients({ type: "controlCenterChanged" }, accountId);
  response.json({ marked });
}));

/** Dismisses the named triggers, or everything in the bell. Urgent ones live in the chat and are only dismissed by name. */
app.post("/api/control-center/triggers/dismiss", route(async (request, response) => {
  const accountId = accountOf(response);
  const body = dismissBody.parse(request.body);
  const dismissed = dismissTriggers(await triggerDatabase(), accountId, "ids" in body ? body.ids : "bell");
  if (dismissed) broadcastToAllClients({ type: "controlCenterChanged" }, accountId);
  response.json({ dismissed });
}));

// Snoozed triggers come back on one timer that starts when the server starts listening, like Bob's reports.
server.once("listening", rearmSnoozeTimer);
// Alerts that no longer need the person leave Bob's chat on their own timer.
server.once("listening", startAlertSweep);
// Each call is followed to the conversation its run started, and settled by how that ended.
server.once("listening", startOutcomeChecks);
