import { sessionCookieName, sessionForId } from "../auth.js";
import { getClusterNode } from "../cluster.js";
import { browserAgentIdentity } from "../browser-agent.js";
import { backgroundTaskAgentIdentity } from "../background-task-agent.js";
import { ntfyAgentIdentity } from "../ntfy-agent.js";
import { worktreeAgentIdentity } from "../worktree-agent.js";
import { getOrCreateClusterIdentity, pinClusterPublicKey } from "../cluster-identity.js";
import { ClusterProtocolError, verifyClusterRequest } from "../cluster-protocol.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { ClusterV2HttpError } from "../cluster-v2-errors.js";
import { hasFeature } from "../features.js";
const clusterRawBodies = /* @__PURE__ */ new WeakMap();
function isClusterV2Url(url) {
  if (url === void 0) return false;
  const pathname = url.split("?", 1)[0].toLowerCase();
  return pathname === "/api/cluster/v2" || pathname.startsWith("/api/cluster/v2/");
}
function captureClusterRawBody(request, _response, body) {
  if (isClusterV2Url(request.url)) clusterRawBodies.set(request, Buffer.from(body));
}
function rejectEncodedClusterBody(request, response, next) {
  const encoding = request.header("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity") {
    response.status(415).json({ error: "Encoded cluster request bodies are not supported" });
    return;
  }
  next();
}
function clusterBodyParserError(error, request, response, next) {
  if (!isClusterV2Url(request.originalUrl)) {
    next(error);
    return;
  }
  const type = error.type;
  if (type === "entity.parse.failed") {
    response.status(400).json({ error: "Malformed cluster JSON" });
    return;
  }
  if (type === "entity.too.large") {
    response.status(413).json({ error: "Cluster request body is too large" });
    return;
  }
  if (type === "encoding.unsupported") {
    response.status(415).json({ error: "Encoded cluster request bodies are not supported" });
    return;
  }
  next(error);
}
function sendError(response, statusCode, message) {
  response.status(statusCode).json({ error: message });
}
function isSecureClusterUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}
function canonicalClusterUrl(value) {
  return new URL(value).origin;
}
function isClusterOriginUrl(value) {
  const url = new URL(value);
  return isSecureClusterUrl(value) && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
}
function securityHeaders(request, response, next) {
  const inlineStyle = "'self' 'unsafe-inline'";
  response.setHeader("Content-Security-Policy", `default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src-elem ${inlineStyle}; style-src-attr ${inlineStyle}; script-src 'self'`);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", request.path === "/" && request.query.canvasPane === "1" ? "SAMEORIGIN" : "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  if (request.path.startsWith("/api/")) response.setHeader("Cache-Control", "no-store");
  next();
}
function bearerToken(request) {
  const match = /^Bearer\s+(.+)$/i.exec(request.header("authorization") ?? "");
  return match?.[1];
}
function requestCookie(request, name) {
  const prefix = `${name}=`;
  return request.header("cookie")?.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
}
function clusterRequestRawBody(request) {
  const captured = clusterRawBodies.get(request);
  const declaredBody = request.header("transfer-encoding") !== void 0 || Number(request.header("content-length") ?? "0") > 0;
  if (!captured && declaredBody) throw new ClusterV2HttpError(415, "Unsupported cluster request body");
  return captured ?? Buffer.alloc(0);
}
async function requireClusterV2Auth(request, response, next) {
  try {
    const captured = clusterRequestRawBody(request);
    const node = await getClusterNode();
    const database = await clusterV2Database();
    const identity = getOrCreateClusterIdentity(database, node.id);
    pinClusterPublicKey(database, node.id, identity.publicKey);
    const sender = verifyClusterRequest(database, node.id, request.method, request.originalUrl, captured, request.header("authorization"));
    response.locals.machineAuth = true;
    response.locals.machineNodeId = sender;
    response.locals.machineProtocol = 2;
    next();
  } catch (error) {
    if (error instanceof ClusterProtocolError) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    if (error instanceof ClusterV2HttpError) {
      sendError(response, error.statusCode, error.message);
      return;
    }
    next(error);
  }
}
async function requireHttpAuth(request, response, next) {
  if (isClusterV2Url(`/api${request.path}`)) {
    await requireClusterV2Auth(request, response, next);
    return;
  }
  const token = bearerToken(request);
  if (request.path === "/browser/agent" && request.method === "POST" && token) {
    const identity = browserAgentIdentity(token);
    if (identity) {
      response.locals.browserAgent = identity;
      response.locals.browserAgentToken = token;
      next();
      return;
    }
  }
  if (request.path === "/background-tasks/agent" && request.method === "POST" && token) {
    const identity = backgroundTaskAgentIdentity(token);
    if (identity) {
      response.locals.taskAgent = identity;
      next();
      return;
    }
  }
  if (request.path === "/ntfy/agent" && request.method === "POST" && token) {
    const identity = ntfyAgentIdentity(token);
    if (identity) {
      response.locals.ntfyAgent = identity;
      next();
      return;
    }
  }
  if (request.path === "/worktrees/agent" && request.method === "POST" && token) {
    const identity = worktreeAgentIdentity(token);
    if (identity) {
      response.locals.worktreeAgent = identity;
      next();
      return;
    }
  }
  const session = sessionForId(requestCookie(request, sessionCookieName));
  if (!session) {
    sendError(response, 401, "Unauthorized");
    return;
  }
  response.locals.authSession = session;
  if (session.mustChangePassword && !["/auth/change-password", "/auth/logout"].includes(request.path)) {
    sendError(response, 403, "Change the initial password before using the application");
    return;
  }
  next();
}
function requireCsrf(request, response, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method) || response.locals.machineAuth || response.locals.browserAgent || response.locals.taskAgent || response.locals.ntfyAgent || response.locals.worktreeAgent) {
    next();
    return;
  }
  const session = response.locals.authSession;
  if (session && request.header("x-csrf-token") === session.csrfToken) {
    next();
    return;
  }
  sendError(response, 403, "Invalid CSRF token");
}
function requireFeature(feature) {
  return (_request, response, next) => {
    const session = response.locals.authSession;
    if (response.locals.machineAuth) {
      next();
      return;
    }
    if (!session) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    if (!hasFeature({ isRemoteLogin: session.isRemoteLogin }, feature)) {
      sendError(response, 403, `Access to ${feature} is not available for replicated users`);
      return;
    }
    next();
  };
}
import { Feature as Feature2 } from "../features.js";
export {
  Feature2 as Feature,
  canonicalClusterUrl,
  captureClusterRawBody,
  clusterBodyParserError,
  clusterRequestRawBody,
  isClusterOriginUrl,
  rejectEncodedClusterBody,
  requestCookie,
  requireCsrf,
  requireFeature,
  requireHttpAuth,
  securityHeaders,
  sendError
};
