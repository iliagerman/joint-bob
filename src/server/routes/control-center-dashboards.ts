import { z } from "zod";
import { appendBobMessage, bobDatabase } from "../../control-center/bob-store.js";
import { runningState } from "../../dashboards/service.js";
import { buildingDashboardIds, startDashboardBuild, type BuildTarget } from "../control-center-dashboard-builds.js";
import { listDashboardCards } from "../control-center-dashboard-cards.js";
import { app } from "../state.js";
import { DashboardError, dashboardRoute, visibleDashboard } from "./dashboards.js";

/** The dashboards the control center's Dashboards tab lists: one card per project and per workspace, plus what Bob is still building. */
app.get("/api/control-center/dashboards", dashboardRoute(async (request, _response, auth) => {
  z.object({}).strict().parse(request.query);
  return { dashboards: await listDashboardCards(auth) };
}));

const askSchema = z.object({ text: z.string().trim().min(1).max(8000) }).strict();

/**
 * "Ask Bob to change it": the request goes into Bob's chat as the person's message and the dashboard-creator agent
 * edits the saved dashboard. Bob saves the result and says so in the chat when it is done.
 */
app.post("/api/control-center/dashboards/:id/ask-bob", dashboardRoute(async (request, response, auth) => {
  const { text } = askSchema.parse(request.body);
  const { record, context } = await visibleDashboard(z.string().uuid().parse(request.params.id), auth);
  if (record.entity.kind === "conversation") throw new DashboardError(409, "Bob changes project and workspace dashboards; change a conversation's dashboard from the conversation");
  if (record.origin !== "own" || record.definitionDigest === null) throw new DashboardError(409, "Bob changes saved dashboards this node owns; make your own copy of this one first");
  if (runningState(record.id) || buildingDashboardIds().has(record.id)) throw new DashboardError(409, "The dashboard is already being worked on; wait for it to finish");
  const project = record.entity.kind === "project" ? { id: record.entity.id, name: context.project.name } : null;
  const target: BuildTarget = { entity: record.entity, hostProjectId: record.hostProjectId, label: context.label, projectId: project?.id ?? null, projectName: project?.name ?? null };
  await startDashboardBuild(auth, target, text, text, record);
  const db = await bobDatabase();
  const where = { projectId: target.projectId, projectName: target.projectName };
  const user = appendBobMessage(db, auth.accountId, { role: "user", text: `Change the dashboard "${record.title}": ${text}`, ...where });
  const reply = appendBobMessage(db, auth.accountId, {
    role: "bob", text: `Changing "${record.title}". The dashboard agent works in the background; I will tell you here when it is done.`, via: "Dashboards · change", ...where,
  });
  response.status(202);
  return { user, reply };
}));
