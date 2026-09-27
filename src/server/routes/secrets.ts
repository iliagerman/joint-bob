import { z } from "zod";
import { ensureManagedHome } from "../../managed-home.js";
import { deleteSecretAccount, getScopeSecretAccounts, listSecretAccounts, saveSecretAccount, setScopeSecretAccounts } from "../../secrets.js";
import { getSettings } from "../../settings.js";
import { deleteWorkspace, listWorkspaces, saveWorkspace } from "../../store.js";
import { workspaceSchema } from "../projects.js";
import { secretAccountSchema, secretScopeParamsSchema, secretScopeSchema } from "../schemas.js";
import { app } from "../state.js";

app.get("/api/secrets", async (_request, response, next) => {
  try { response.json({ accounts: await listSecretAccounts() }); } catch (error) { next(error); }
});
app.post("/api/secrets/accounts", async (request, response, next) => {
  try {
    const account = await saveSecretAccount(secretAccountSchema.parse(request.body));
    response.status(201).json({ accounts: await listSecretAccounts(), account });
  } catch (error) { next(error); }
});
app.put("/api/secrets/accounts/:accountId", async (request, response, next) => {
  try {
    const account = await saveSecretAccount({ ...secretAccountSchema.parse(request.body), id: z.string().uuid().parse(request.params.accountId) });
    response.json({ accounts: await listSecretAccounts(), account });
  } catch (error) { next(error); }
});
app.delete("/api/secrets/accounts/:accountId", async (request, response, next) => {
  try { await deleteSecretAccount(z.string().uuid().parse(request.params.accountId)); response.json({ accounts: await listSecretAccounts() }); } catch (error) { next(error); }
});
app.get("/api/secrets/scopes/:scopeType/:scopeId", async (request, response, next) => {
  try { const scope = secretScopeParamsSchema.parse(request.params); response.json(await getScopeSecretAccounts(scope.scopeType, scope.scopeId)); } catch (error) { next(error); }
});
app.put("/api/secrets/scopes/:scopeType/:scopeId", async (request, response, next) => {
  try {
    const scope = secretScopeParamsSchema.parse(request.params);
    const payload = secretScopeSchema.parse(request.body);
    await setScopeSecretAccounts(scope.scopeType, scope.scopeId, payload.accountIds);
    response.json(await getScopeSecretAccounts(scope.scopeType, scope.scopeId));
  } catch (error) { next(error); }
});

app.get("/api/workspaces", async (_request, response, next) => {
  try {
    response.json({ workspaces: await listWorkspaces() });
  } catch (error) {
    next(error);
  }
});

app.put("/api/workspaces", async (request, response, next) => {
  try {
    const payload = workspaceSchema.parse(request.body);
    const workspace = await saveWorkspace(payload);
    await ensureManagedHome(getSettings().projects.homePath, (await listWorkspaces()).map((entry) => entry.id));
    response.json({ workspace });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/workspaces/:workspaceId", async (request, response, next) => {
  try {
    await deleteWorkspace(request.params.workspaceId);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

