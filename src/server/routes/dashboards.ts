import type { NextFunction, Request, Response } from "express";
import type { AuthSession } from "../../auth.js";
import { NotFoundError } from "../../not-found.js";
import { resolveEntity } from "../../dashboards/entity.js";
import { composeFrame, FRAME_CONTENT_SECURITY_POLICY } from "../../dashboards/frame.js";
import { readDraftFiles, readLiveDefinition, readPayload } from "../../dashboards/files.js";
import { getDashboard, type DashboardRecord } from "../../dashboards/store.js";
import { app } from "../state.js";

export class DashboardError extends Error {
  readonly expose = true;
  constructor(readonly status: number, message: string) { super(message); }
}

type Handler = (request: Request, response: Response, auth: AuthSession) => Promise<unknown>;

/** JSON routes: the result is the response body; errors go to the shared API error handler. */
export function dashboardRoute(handler: Handler) {
  return (request: Request, response: Response, next: NextFunction): void => {
    handler(request, response, response.locals.authSession as AuthSession)
      .then((body) => { if (!response.headersSent) response.json(body); })
      .catch(next);
  };
}

/** A dashboard the person may see, with its entity checked on this node. */
export async function visibleDashboard(id: string, auth: AuthSession): Promise<{ record: DashboardRecord; context: Awaited<ReturnType<typeof resolveEntity>> }> {
  const record = getDashboard(id);
  if (!record) throw new NotFoundError("Dashboard not found");
  return { record, context: await resolveEntity(record.entity, record.hostProjectId, auth) };
}

function frameHtml(id: string, draft: boolean): string {
  if (draft) {
    const page = readDraftFiles(id).find((file) => file.path === "index.html");
    if (!page) throw new NotFoundError("The draft has no index.html yet");
    return page.content.toString("utf8");
  }
  const live = readLiveDefinition(id);
  if (!live) throw new NotFoundError("Dashboard has not been saved yet");
  return live.html;
}

app.get("/api/dashboards/:id/frame", dashboardRoute(async (request, response, auth) => {
  await visibleDashboard(String(request.params.id), auth);
  const draft = request.query.draft === "1";
  const html = composeFrame({
    html: frameHtml(String(request.params.id), draft),
    payload: readPayload(String(request.params.id), draft ? "draft" : "live"),
    theme: request.query.theme === "light" ? "light" : "dark",
  });
  response.setHeader("Content-Security-Policy", FRAME_CONTENT_SECURITY_POLICY);
  response.type("html").send(html);
}));
