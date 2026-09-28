import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dispatchSignedRuntime, twinRuntimeGuard } from "../runtime-peers.js";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { authenticate, authenticationStatus, AuthError, type AuthSession, type MfaLoginChallenge, beginMfaSetup, cancelMfaSetup, changePassword, clearSessionCookieValue, completeMfaLogin, confirmMfaSetup, createAdministrator, listLoginSessions, manageMfa, mfaStatus, revokeSession, revokeUserSession, sessionCookieName, sessionCookieValue, sessionForId } from "../../auth.js";
import { appVersion } from "../../changelog.js";
import { captureClusterRawBody, clusterBodyParserError, rejectEncodedClusterBody, requestCookie, requireCsrf, requireHttpAuth, securityHeaders, sendError } from "../http-auth.js";
import { loginSchema, passwordChangeSchema } from "../schemas.js";
import { app, codemirrorDir, flags, publicDir } from "../state.js";
import { redeemV2Membership } from "../cluster-v2.js";
import { receiveManagerCertificate } from "../cluster-manager.js";
import { confirmTwinHttp } from "../twins.js";

app.use(securityHeaders);
app.set("trust proxy", 1);
// Browsers request /favicon.ico regardless of the <link rel="icon"> tags; without
// this the path falls through to the SPA and the tab gets HTML instead of an image.
app.get("/favicon.ico", (_request, response) => {
  response.type("image/png").sendFile(path.join(publicDir, "icon-192.png"));
});
/** Hashes the cached app shell, so changed files rename the cache even when the version stays the same. */
async function appShellDigest(source: string): Promise<string> {
  const shell: string[] = JSON.parse(source.match(/^const APP_SHELL = (\[.*\]);$/m)?.[1] ?? "[]");
  const hash = createHash("sha256");
  for (const url of shell) {
    const file = url === "/" ? path.join(publicDir, "index.html") : url.startsWith("/vendor/codemirror/") ? path.join(codemirrorDir, url.slice("/vendor/codemirror/".length)) : path.join(publicDir, url);
    hash.update(url).update(await readFile(file).catch(() => Buffer.alloc(0)));
  }
  return hash.digest("hex").slice(0, 12);
}

app.get("/sw.js", async (_request, response, next) => {
  try {
    const source = await readFile(path.join(publicDir, "sw.js"), "utf8");
    const worker = source.replace(/^const CACHE_NAME = "[^"]+";/, `const CACHE_NAME = "joint-bob-${appVersion()}-${await appShellDigest(source)}";`);
    if (worker === source) throw new Error("Service worker cache name is missing");
    response.type("application/javascript").set("Cache-Control", "no-cache").send(worker);
  } catch (error) {
    next(error);
  }
});
app.use("/vendor/codemirror", express.static(codemirrorDir, { index: false }));
app.use(express.static(publicDir));
app.use("/api/cluster/v2", rejectEncodedClusterBody);
app.use(express.json({ limit: "56mb", verify: captureClusterRawBody }));
app.use(clusterBodyParserError);
app.post("/api/cluster/v2/membership/redeem", redeemV2Membership);
app.post("/api/cluster/v2/manager-transfer/certificate", receiveManagerCertificate);
app.post("/api/cluster/v2/twins/confirm", confirmTwinHttp);

app.get("/api/auth/status", (request, response) => {
  response.json(authenticationStatus(sessionForId(requestCookie(request, sessionCookieName))));
});

app.get("/api/health", (_request, response) => {
  // The semantic version is what the user sees; the commit stays for diagnostics.
  const version = appVersion();
  const release = process.env.JOINT_BOB_RELEASE ?? process.env.MASTER_BOB_RELEASE ?? "development";
  if (flags.updatePreparing) {
    response.set("Retry-After", "5").status(503).json({ status: "updating", version, release });
    return;
  }
  if (!flags.startupReady) {
    response.status(503).json({ status: "starting", version, release });
    return;
  }
  response.json({ status: "ok", version, release });
});

function sendLogin(response: Response, result: AuthSession | MfaLoginChallenge): void {
  if ("mfaRequired" in result) { response.json(result); return; }
  response.setHeader("Set-Cookie", sessionCookieValue(result));
  response.json({ mustChangePassword: result.mustChangePassword, csrfToken: result.csrfToken, username: result.username });
}

function authError(error: unknown, _request: Request, response: Response, next: NextFunction): void {
  if (error instanceof AuthError) { sendError(response, error.statusCode, error.message); return; }
  if (error instanceof z.ZodError) { sendError(response, 400, error.errors.map(issue => issue.message).join(", ")); return; }
  next(error);
}

const mfaCodeSchema = z.object({ code: z.string().trim().min(1).max(64) }).strict();
const mfaPasswordSchema = z.object({ currentPassword: z.string().min(1).max(200) }).strict();
const mfaLoginSchema = mfaCodeSchema.extend({ challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const mfaManagementSchema = mfaPasswordSchema.extend({ code: mfaCodeSchema.shape.code });

app.post("/api/auth/setup", (request, response, next) => {
  try {
    const payload = loginSchema.parse(request.body);
    if (!authenticationStatus().setupRequired) {
      sendError(response, 409, "Administrator already exists");
      return;
    }
    createAdministrator(payload.username, payload.password, false);
    const session = authenticate(payload.username, payload.password);
    sendLogin(response.status(201), session);
  } catch (error) {
    if (error instanceof z.ZodError) {
      sendError(response, 400, error.errors.map((issue) => issue.message).join(", "));
      return;
    }
    next(error);
  }
});

app.post("/api/auth/login", (request, response, next) => {
  try {
    const payload = loginSchema.parse(request.body);
    const session = authenticate(payload.username, payload.password);
    sendLogin(response, session);
  } catch (error) {
    if (error instanceof z.ZodError) {
      sendError(response, 400, error.errors.map((issue) => issue.message).join(", "));
      return;
    }
    if (error instanceof AuthError) { sendError(response, error.statusCode, error.message); return; }
    if (error instanceof Error && ["Invalid username or password", "Too many login attempts. Try again in 15 minutes"].includes(error.message)) {
      sendError(response, 401, error.message);
      return;
    }
    next(error);
  }
});

app.post("/api/auth/login/mfa", (request, response, next) => {
  try {
    const payload = mfaLoginSchema.parse(request.body);
    sendLogin(response, completeMfaLogin(payload.challenge, payload.code));
  } catch (error) { authError(error, request, response, next); }
});

app.use("/api", requireHttpAuth, requireCsrf);
app.use("/api/cluster/v2/runtime", twinRuntimeGuard);
app.use(dispatchSignedRuntime);
app.use("/api", (request, response, next) => {
  if (flags.updatePreparing && !["GET", "HEAD", "OPTIONS"].includes(request.method) && request.path !== "/cluster/v2/update/prepare") {
    response.status(503).json({ error: "Server update in progress" });
    return;
  }
  next();
});

const mfaRouter = express.Router();
mfaRouter.get("/", (_request, response) => { response.json(mfaStatus((response.locals.authSession as AuthSession).userId)); });
mfaRouter.post("/setup", (request, response) => {
  const payload = mfaPasswordSchema.parse(request.body);
  response.json(beginMfaSetup(response.locals.authSession, payload.currentPassword));
});
mfaRouter.delete("/setup", (_request, response) => { cancelMfaSetup(response.locals.authSession); response.status(204).send(); });
mfaRouter.post("/confirm", (request, response) => { response.json(confirmMfaSetup(response.locals.authSession, mfaCodeSchema.parse(request.body).code)); });
for (const action of ["disable", "recovery-codes"] as const) {
  mfaRouter.post(`/${action}`, (request, response) => {
    const payload = mfaManagementSchema.parse(request.body);
    response.json(manageMfa(response.locals.authSession, payload.currentPassword, payload.code, action));
  });
}
mfaRouter.use(authError);
app.use("/api/auth/mfa", mfaRouter);

app.post("/api/auth/change-password", (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    const payload = passwordChangeSchema.parse(request.body);
    changePassword(session, payload.currentPassword, payload.newPassword);
    response.status(204).send();
  } catch (error) {
    if (error instanceof z.ZodError) {
      sendError(response, 400, error.errors.map((issue) => issue.message).join(", "));
      return;
    }
    if (error instanceof Error && error.message === "Current password is incorrect") {
      sendError(response, 400, error.message);
      return;
    }
    next(error);
  }
});

app.post("/api/auth/logout", (_request, response) => {
  const session = response.locals.authSession as AuthSession;
  revokeSession(session.id);
  response.setHeader("Set-Cookie", clearSessionCookieValue());
  response.status(204).send();
});

app.get("/api/auth/sessions", (_request, response) => {
  const session = response.locals.authSession as AuthSession;
  response.json({ currentSessionId: session.id, sessions: listLoginSessions(session.userId) });
});

app.delete("/api/auth/sessions/:sessionId", (request, response) => {
  const session = response.locals.authSession as AuthSession;
  if (!revokeUserSession(session.userId, request.params.sessionId)) {
    sendError(response, 404, "Login session not found");
    return;
  }
  if (request.params.sessionId === session.id) response.setHeader("Set-Cookie", clearSessionCookieValue());
  response.status(204).send();
});
