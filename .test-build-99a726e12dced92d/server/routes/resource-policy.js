import { z } from "zod";
import { getClusterNode } from "../../cluster.js";
import {
  applyResourcePolicy,
  resourcePolicySchema,
  ResourceSharingError
} from "../../cluster-sharing.js";
import { projectMetadataEnvelopeSchema } from "../../cluster-project-metadata.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { getSettings } from "../../settings.js";
import { ClusterV2HttpError } from "../../cluster-v2-errors.js";
import { applyProjectMetadata, applyProjectResourcePolicy } from "../../store.js";
import { sendError } from "../http-auth.js";
import { app } from "../state.js";
import { disconnectRevokedRuntimeSockets } from "../runtime-peers.js";
const envelopeSchema = z.object({ statement: resourcePolicySchema }).strict();
function protocolStatus(error) {
  if (/^(Resource revocation shares must be empty|Twin resource fragment shares must be empty|Invalid context fragment|Invalid project context fragment|Secret context fragment must not be empty|Resource shares are not canonical)$/.test(error.message)) return 400;
  if (/^(Invalid resource policy signature|Resource owner public key is not pinned)$/.test(error.message)) return 401;
  if (/^(Unauthorized cluster policy context|Unauthorized twin policy context|Only owner may revoke policy|Unknown resource revocation context|Invalid resource policy authority|Resource original owner cannot be changed|Unknown cluster:.*)/.test(error.message)) return 403;
  if (/^(Stale resource policy|Stale resource deletion|Conflicting resource policy generation|Conflicting project metadata revision|Deleted resource cannot be restored|Resource deletion is terminal)$/.test(error.message)) return 409;
  return void 0;
}
app.post("/api/cluster/v2/resources/project-metadata", (request, response, next) => {
  void (async () => {
    if (response.locals.machineProtocol !== 2 || typeof response.locals.machineNodeId !== "string") {
      throw new ClusterV2HttpError(401, "Unauthorized");
    }
    const payload = projectMetadataEnvelopeSchema.parse(request.body);
    const local = await getClusterNode();
    await applyProjectMetadata(
      local.id,
      response.locals.machineNodeId,
      payload,
      getSettings().projects.homePath
    );
    response.json({ operationId: payload.statement.body.operationId, revision: payload.revision });
  })().catch((error) => {
    if (error instanceof z.ZodError) {
      sendError(response, 400, "Invalid project metadata");
      return;
    }
    if (error instanceof ResourceSharingError || error instanceof ClusterV2HttpError) {
      sendError(response, error.statusCode, error.message);
      return;
    }
    if (error instanceof Error) {
      const status = protocolStatus(error);
      if (status) {
        sendError(response, status, status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Invalid project metadata");
        return;
      }
    }
    next(error);
  });
});
app.post("/api/cluster/v2/resources/policy", (request, response, next) => {
  void (async () => {
    if (response.locals.machineProtocol !== 2 || typeof response.locals.machineNodeId !== "string") {
      throw new ClusterV2HttpError(401, "Unauthorized");
    }
    const payload = envelopeSchema.parse(request.body);
    const local = await getClusterNode();
    const sender = response.locals.machineNodeId;
    if (payload.statement.body.kind === "project") {
      await applyProjectResourcePolicy(local.id, sender, payload.statement);
    } else {
      const db = await clusterV2Database();
      applyResourcePolicy(db, local.id, sender, payload.statement);
    }
    await disconnectRevokedRuntimeSockets();
    response.json({ operationId: payload.statement.body.operationId });
  })().catch((error) => {
    if (error instanceof z.ZodError) {
      sendError(response, 400, "Invalid resource policy");
      return;
    }
    if (error instanceof ResourceSharingError || error instanceof ClusterV2HttpError) {
      sendError(response, error.statusCode, error.message);
      return;
    }
    if (error instanceof Error) {
      const status = protocolStatus(error);
      if (status) {
        sendError(response, status, status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Invalid resource policy");
        return;
      }
    }
    next(error);
  });
});
