import { readFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import { z } from "zod";
import { authenticate, authenticationStatus, type AuthSession, changePassword, clearSessionCookieValue, createAdministrator, listLoginSessions, revokeSession, revokeUserSession, sessionCookieName, sessionCookieValue, sessionForId } from "../../auth.js";
import { appVersion } from "../../changelog.js";
import { clusterInvitationStatus, consumeClusterInvitation, createClusterPeer, getClusterMembership, getClusterNode, listClusterPeers, saveClusterPeer } from "../../cluster.js";
import { clusterInvitationConflict, requestCookie, requireCsrf, requireHttpAuth, securityHeaders, sendError } from "../http-auth.js";
import { clusterInvitationRedeemSchema, loginSchema, passwordChangeSchema } from "../schemas.js";
import { app, codemirrorDir, flags, publicDir } from "../state.js";

app.use(securityHeaders);
app.set("trust proxy", 1);
// Browsers request /favicon.ico regardless of the <link rel="icon"> tags; without
// this the path falls through to the SPA and the tab gets HTML instead of an image.
app.get("/favicon.ico", (_request, response) => {
  response.type("image/png").sendFile(path.join(publicDir, "icon-192.png"));
});
app.get("/sw.js", async (_request, response, next) => {
  try {
    const source = await readFile(path.join(publicDir, "sw.js"), "utf8");
    const worker = source.replace(/^const CACHE_NAME = "[^"]+";/, `const CACHE_NAME = "joint-bob-${appVersion()}";`);
    if (worker === source) throw new Error("Service worker cache name is missing");
    response.type("application/javascript").set("Cache-Control", "no-cache").send(worker);
  } catch (error) {
    next(error);
  }
});
app.use("/vendor/codemirror", express.static(codemirrorDir, { index: false }));
app.use(express.static(publicDir));
app.use(express.json({ limit: "56mb" }));

app.get("/api/auth/status", (request, response) => {
  response.json(authenticationStatus(sessionForId(requestCookie(request, sessionCookieName))));
});

app.get("/api/health", (_request, response) => {
  // The semantic version is what the user sees; the commit stays for diagnostics.
  const version = appVersion();
  const release = process.env.JOINT_BOB_RELEASE ?? process.env.MASTER_BOB_RELEASE ?? "development";
  if (!flags.startupReady) {
    response.status(503).json({ status: "starting", version, release });
    return;
  }
  response.json({ status: "ok", version, release });
});

app.post("/api/auth/setup", (request, response, next) => {
  try {
    const payload = loginSchema.parse(request.body);
    if (!authenticationStatus().setupRequired) {
      sendError(response, 409, "Administrator already exists");
      return;
    }
    createAdministrator(payload.username, payload.password, false);
    const session = authenticate(payload.username, payload.password);
    response.setHeader("Set-Cookie", sessionCookieValue(session));
    response.status(201).json({ mustChangePassword: false, csrfToken: session.csrfToken, username: session.username });
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
    response.setHeader("Set-Cookie", sessionCookieValue(session));
    response.json({ mustChangePassword: session.mustChangePassword, csrfToken: session.csrfToken, username: session.username });
  } catch (error) {
    if (error instanceof z.ZodError) {
      sendError(response, 400, error.errors.map((issue) => issue.message).join(", "));
      return;
    }
    if (error instanceof Error && ["Invalid username or password", "Too many login attempts. Try again in 15 minutes"].includes(error.message)) {
      sendError(response, 401, error.message);
      return;
    }
    next(error);
  }
});

app.post("/api/cluster/invitations/redeem", async (request, response, next) => {
  try {
    const payload = clusterInvitationRedeemSchema.parse(request.body);
    const invitationResult = await clusterInvitationStatus(payload.invitationId, payload.secret, payload.member.id);
    if (invitationResult === "invalid") { sendError(response, 401, "Invalid cluster invitation"); return; }
    if (invitationResult === "expired") { sendError(response, 410, "Cluster invitation has expired"); return; }
    if (invitationResult === "used") { sendError(response, 410, "Cluster invitation has already been used"); return; }
    const [localNode, peers] = await Promise.all([getClusterNode(), listClusterPeers()]);
    const conflict = clusterInvitationConflict(payload.member, localNode, peers, invitationResult === "retry");
    if (conflict) { sendError(response, 409, conflict); return; }
    const existing = peers.find((peer) => peer.id === payload.member.id);
    if (!existing && peers.length >= 4) { sendError(response, 409, "A cluster supports at most five nodes"); return; }
    const claimed = await consumeClusterInvitation(payload.invitationId, payload.secret, payload.member.id);
    if (claimed === "invalid") { sendError(response, 401, "Invalid cluster invitation"); return; }
    if (claimed === "expired") { sendError(response, 410, "Cluster invitation has expired"); return; }
    if (claimed === "used") { sendError(response, 410, "Cluster invitation has already been used"); return; }
    if (!existing) {
      const { token, ...node } = payload.member;
      await saveClusterPeer(createClusterPeer(node, token));
    }
    response.status(201).json({ inviterNodeId: localNode.id, membership: await getClusterMembership() });
  } catch (error) {
    next(error);
  }
});

app.use("/api", requireHttpAuth, requireCsrf);
app.use("/api", (request, response, next) => {
  if (flags.updatePreparing && !["GET", "HEAD", "OPTIONS"].includes(request.method) && request.path !== "/update/prepare") {
    response.status(503).json({ error: "Server update in progress" });
    return;
  }
  next();
});

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
