import { z } from "zod";
import { acceptAdminTransfer, AuthError, cancelAdminTransfer, createLocalUser, deleteLocalUser, listLocalUsers, localUser, offerAdminTransfer, pendingAdminTransfer, setLocalUserDisabled, type AuthSession } from "../../auth.js";
import { runAsAccount } from "../../account-context.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { multiUserStatus } from "../../multi-user.js";
import { seedPersonalSettings } from "../../settings.js";
import { saveWorkspace } from "../../store.js";
import { deleteAccountData, materializeAdminOwnership } from "../account-data.js";
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

// Admin-only (see admin.ts): accounts, never activity.
app.get("/api/users", (_request, response) => {
  const pending = pendingAdminTransfer();
  response.json({ users: listLocalUsers(), multiUser: multiUserStatus(), adminTransfer: pending ?? null });
});

app.post("/api/users", async (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    const status = multiUserStatus();
    if (!status.ready) { sendError(response, 409, "Set up multi-user mode before adding people"); return; }
    const input = createSchema.parse(request.body);
    const created = createLocalUser(input, session.userId);
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
