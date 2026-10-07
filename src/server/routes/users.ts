import { save, settingsDatabase, value } from "../../settings-store.js";
import { z } from "zod";
import { acceptAdminTransfer, AuthError, cancelAdminTransfer, createLocalUser, deleteLocalUser, listLocalUsers, localUser, offerAdminTransfer, pendingAdminTransfer, setLocalUserDisabled, type AuthSession } from "../../auth.js";
import { runAsAccount } from "../../account-context.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { multiUserStatus } from "../../multi-user.js";
import { seedPersonalSettings } from "../../settings.js";
import { saveWorkspace } from "../../store.js";
import { deleteAccountData, materializeAdminOwnership } from "../account-data.js";
import { createAccountRuntime, deleteAccountRuntime, enableMultiUser, MultiUserSetupError, runSelfTest } from "../multi-user-setup.js";
import { helperInstalled, multiUserEnabled } from "../../account-runtime.js";
import { sendError } from "../http-auth.js";
import { app } from "../state.js";

const userId = z.string().min(1).max(64);
const createSchema = z.object({ username: z.string().trim().min(1).max(28), email: z.string().trim().min(1).max(254) }).strict();
const updateSchema = z.object({ disabled: z.boolean() }).strict();
const deleteSchema = z.object({ confirm: z.string().min(1).max(80) }).strict();

function authFailure(error: unknown, response: Parameters<typeof sendError>[0], next: (error: unknown) => void): void {
  if (error instanceof AuthError) { sendError(response, error.statusCode, error.message); return; }
  if (error instanceof z.ZodError) { sendError(response, 400, error.errors.map((issue) => issue.message).join(", ")); return; }
  next(error);
}

/** A second person needs the machine wall up: the self-test passed and the mode is on. */
function canAddPeople(): boolean {
  return multiUserStatus().ready && (multiUserEnabled() || process.env.JOINT_BOB_TEST_MULTI_USER_READY === "1");
}

// Admin-only (see admin.ts): accounts, never activity.
app.get("/api/users", (_request, response) => {
  const pending = pendingAdminTransfer();
  response.json({ users: listLocalUsers(), multiUser: { ...multiUserStatus(), enabled: multiUserEnabled(), helperPresent: helperInstalled(), canAddPeople: canAddPeople(), claudeToken: Boolean(value("multiUser.claudeToken", "")) }, adminTransfer: pending ?? null });
});

// Admin-only: the node's Claude subscription for people's accounts. Saved, never shown again.
app.put("/api/multi-user/claude-token", (request, response, next) => {
  try {
    const { token } = z.object({ token: z.string().trim().regex(/^\S{20,500}$/, "Paste the token `claude setup-token` printed").nullable() }).strict().parse(request.body);
    const db = settingsDatabase();
    if (token) save(db, "multiUser.claudeToken", token, true);
    else db.prepare("DELETE FROM node_settings WHERE key = 'multiUser.claudeToken'").run();
    response.json({ claudeToken: Boolean(token) });
  } catch (error) { authFailure(error, response, next); }
});

// Admin-only: prove the wall on this machine, then move the node into multi-user mode.
app.post("/api/multi-user/self-test", async (_request, response, next) => {
  try { response.json(await runSelfTest()); } catch (error) { next(error); }
});

app.post("/api/multi-user/enable", async (_request, response, next) => {
  try { await enableMultiUser(); response.json({ enabled: true }); }
  catch (error) {
    if (error instanceof MultiUserSetupError) { sendError(response, error.statusCode, error.message); return; }
    next(error);
  }
});

app.post("/api/users", async (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    if (!canAddPeople()) { sendError(response, 409, "Set up multi-user mode before adding people"); return; }
    const input = createSchema.parse(request.body);
    const created = createLocalUser(input, session.userId);
    try { await createAccountRuntime(created.user.accountId, created.user.username); }
    catch (error) { deleteLocalUser(created.user.userId, session.userId); throw error; }
    seedPersonalSettings(created.user.accountId);
    // A new person starts with a workspace of their own.
    await runAsAccount({ accountId: created.user.accountId, userId: created.user.userId, username: created.user.username, email: created.user.email, role: "member", isRemoteLogin: false, homeNodeId: null }, () => saveWorkspace({ label: "Personal", id: "personal" }));
    response.status(201).json({ user: created.user, oneTimePassword: created.oneTimePassword });
  } catch (error) { authFailure(error, response, next); }
});

app.put("/api/users/:userId", (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    const { disabled } = updateSchema.parse(request.body);
    response.json({ user: setLocalUserDisabled(userId.parse(request.params.userId), disabled, session.userId) });
  } catch (error) { authFailure(error, response, next); }
});

app.delete("/api/users/admin-transfer", (_request, response, next) => {
  try {
    cancelAdminTransfer((response.locals.authSession as AuthSession).userId);
    response.status(204).send();
  } catch (error) { authFailure(error, response, next); }
});

/** Deleting a person deletes everything they had here. It is typed out, never clicked. */
app.delete("/api/users/:userId", async (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    const user = localUser(userId.parse(request.params.userId));
    if (!user) { sendError(response, 404, "User not found"); return; }
    const { confirm } = deleteSchema.parse(request.body ?? {});
    if (confirm !== user.username) { sendError(response, 400, "Type the username to confirm"); return; }
    if (user.role === "admin") { sendError(response, 409, "The admin account can't be deleted"); return; }
    await deleteAccountData(user.accountId);
    await deleteAccountRuntime(user.accountId, user.username);
    deleteLocalUser(user.userId, session.userId);
    response.status(204).send();
  } catch (error) { authFailure(error, response, next); }
});

app.post("/api/users/:userId/admin-transfer", (request, response, next) => {
  try {
    offerAdminTransfer(userId.parse(request.params.userId), (response.locals.authSession as AuthSession).userId);
    response.json({ adminTransfer: pendingAdminTransfer() ?? null });
  } catch (error) { authFailure(error, response, next); }
});

// For the person the role is offered to, not admin-gated.
app.get("/api/account/admin-transfer", (_request, response) => {
  const session = response.locals.authSession as AuthSession;
  response.json({ offered: !session.isRemoteLogin && pendingAdminTransfer()?.toUserId === session.userId });
});

app.post("/api/account/admin-transfer/accept", async (_request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    const db = await clusterV2Database();
    acceptAdminTransfer(session, (oldAdmin) => materializeAdminOwnership(db, oldAdmin, session.accountId));
    response.json({ role: "admin" });
  } catch (error) { authFailure(error, response, next); }
});
