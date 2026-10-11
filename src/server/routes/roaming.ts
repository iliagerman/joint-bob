import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { AuthSession } from "../../auth.js";
import { ClusterV2HttpError } from "../../cluster-v2-errors.js";
import { sendError } from "../http-auth.js";
import { forgetRoamingNode, HomeOfflineError, receiveForget, receiveProfile, receiveRoamingEdit, receiveSignedIn, visitorProfileStatus } from "../roaming.js";
import { app } from "../state.js";
import { receiveLiveRequest } from "../live-link.js";

function machineSender(locals: Record<string, unknown>): string | undefined {
  return locals.machineProtocol === 2 && typeof locals.machineNodeId === "string" ? locals.machineNodeId : undefined;
}

function failure(error: unknown, response: Response, next: NextFunction): void {
  if (error instanceof z.ZodError) { sendError(response, 400, "Invalid request"); return; }
  if (error instanceof ClusterV2HttpError) { sendError(response, error.statusCode, error.message); return; }
  if (error instanceof HomeOfflineError) { sendError(response, error.statusCode, error.message); return; }
  next(error);
}

/** Node-to-node: the signature names the sender; each handler checks it may say this. */
function fromPeer(handler: (sender: string, body: unknown) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => {
    const sender = machineSender(response.locals);
    if (!sender) { sendError(response, 401, "Unauthorized"); return; }
    handler(sender, request.body).then(() => response.json({ received: true }), (error) => failure(error, response, next));
  };
}

app.post("/api/cluster/v2/accounts/signed-in", fromPeer(receiveSignedIn));
app.post("/api/cluster/v2/accounts/profile", fromPeer(receiveProfile));
app.post("/api/cluster/v2/accounts/forget", fromPeer(receiveForget));
app.post("/api/cluster/v2/accounts/edit", fromPeer(receiveRoamingEdit));

// A visitor's pages: is their profile here yet, and can edits reach home?
app.get("/api/account/profile-status", (_request, response, next) => {
  const session = response.locals.authSession as AuthSession | undefined;
  if (!session) { sendError(response, 401, "Unauthorized"); return; }
  if (!session.isRemoteLogin) { response.json({ visitor: false }); return; }
  visitorProfileStatus(session.accountId).then((status) => response.json({ visitor: true, ...status }), (error) => failure(error, response, next));
});

// "Forget this node", from home: the copy there goes and the person is signed out there.
app.post("/api/account/nodes/:nodeId/forget", (request, response, next) => {
  const session = response.locals.authSession as AuthSession | undefined;
  if (!session) { sendError(response, 401, "Unauthorized"); return; }
  if (session.isRemoteLogin) { sendError(response, 404, "Not found"); return; }
  const nodeId = z.string().uuid().safeParse(request.params.nodeId);
  if (!nodeId.success) { sendError(response, 400, "Invalid request"); return; }
  forgetRoamingNode(session.accountId, nodeId.data).then(() => response.json({ forgotten: true }), (error) => failure(error, response, next));
});

// Your unshared projects, relayed live from a node you signed in to (live-link.ts).
app.all("/api/cluster/v2/live/:accountId/*", receiveLiveRequest);
