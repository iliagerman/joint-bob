import { z } from "zod";
import type { AuthSession } from "../../auth.js";
import "../../control-center/moves-bob.js";
import { cancelMoveJob, getMoveJob, listMoveJobs, MoveError, planMoves, startMoveJob, type MoveJob, type MovePlan } from "../../control-center/moves.js";
import { createMoveEnvironment, listMoveNodes, localMoveBlockers, moveCheckSchema } from "../../control-center/moves-runtime.js";
import { sendError } from "../http-auth.js";
import { app } from "../state.js";

const refSchema = z.object({ projectId: z.string().min(1).max(200), conversationId: z.string().min(1).max(300) }).strict();
const planSchema = z.object({ target: z.string().uuid(), conversations: z.array(refSchema).min(1).max(100) }).strict();
const runSchema = planSchema.extend({ mode: z.enum(["after-turn", "now"]) }).strict();

const publicPlan = (plan: MovePlan) => ({
  target: { id: plan.target.id, name: plan.target.name },
  entries: plan.entries.map((entry) => ({
    projectId: entry.ref.projectId, conversationId: entry.ref.conversationId, title: entry.title, projectName: entry.projectName,
    from: entry.fromName, turnRunning: entry.turnRunning, verdict: entry.verdict, reasons: entry.reasons,
  })),
});

const publicJob = ({ accountId: _accountId, ...job }: MoveJob) => job;

function fail(error: unknown, response: import("express").Response, next: import("express").NextFunction): void {
  if (error instanceof z.ZodError) { sendError(response, 400, "Invalid request to move conversations"); return; }
  if (error instanceof MoveError) { sendError(response, error.status, error.message); return; }
  next(error);
}

/** The machines a conversation could move to, with whether each answers now. */
app.get("/api/control-center/moves/nodes", async (_request, response, next) => {
  try { response.json({ nodes: await listMoveNodes() }); } catch (error) { next(error); }
});

/** What would happen to each conversation if it moved to the machine: moves, is already there, or cannot and why. */
app.post("/api/control-center/moves/plan", async (request, response, next) => {
  try {
    const input = planSchema.parse(request.body);
    response.json(publicPlan(await planMoves(createMoveEnvironment(response.locals.authSession as AuthSession), input.conversations, input.target)));
  } catch (error) { fail(error, response, next); }
});

/** Starts the batch. It answers at once; follow it with GET /api/control-center/moves/:id. */
app.post("/api/control-center/moves", async (request, response, next) => {
  try {
    const input = runSchema.parse(request.body);
    const session = response.locals.authSession as AuthSession;
    const env = createMoveEnvironment(session);
    const plan = await planMoves(env, input.conversations, input.target);
    const { job } = startMoveJob(env, session.accountId, plan, input.mode);
    response.status(202).json({ job: publicJob(job) });
  } catch (error) { fail(error, response, next); }
});

app.get("/api/control-center/moves", (_request, response) => {
  response.json({ jobs: listMoveJobs((response.locals.authSession as AuthSession).accountId).map(publicJob) });
});

app.get("/api/control-center/moves/:id", (request, response) => {
  const job = getMoveJob((response.locals.authSession as AuthSession).accountId, request.params.id);
  if (!job) { sendError(response, 404, "That move is no longer listed"); return; }
  response.json({ job: publicJob(job) });
});

/** Stops conversations that are still waiting for a turn to end from moving. */
app.post("/api/control-center/moves/:id/cancel", (request, response) => {
  const job = cancelMoveJob((response.locals.authSession as AuthSession).accountId, request.params.id);
  if (!job) { sendError(response, 404, "That move is no longer listed"); return; }
  response.json({ job: publicJob(job) });
});

/** Another machine asks whether a conversation could run here: its project, harness, login and model are checked on this machine. */
app.post(["/api/cluster/sessions/move-check", "/api/cluster/v2/runtime/sessions/move-check"], async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    response.json({ reasons: await localMoveBlockers(moveCheckSchema.parse(request.body), response.locals.machineNodeId as string) });
  } catch (error) { fail(error, response, next); }
});
