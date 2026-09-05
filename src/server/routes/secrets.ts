import { z } from "zod";
import type { AuthSession } from "../../auth.js";
import { type ClusterPeer, listClusterPeers } from "../../cluster.js";
import { ensureManagedHome } from "../../managed-home.js";
import { enqueueSecretCredentialSync } from "../../secret-replication.js";
import { deleteSecretAccount, getScopeSecretAccounts, listSecretAccounts, saveSecretAccount, setScopeSecretAccounts } from "../../secrets.js";
import { getSettings } from "../../settings.js";
import { deleteWorkspace, listWorkspaces, saveWorkspace } from "../../store.js";
import { sendError } from "../http-auth.js";
import { pushSecretCredentialsToPeer, replicateSecretAccount, replicateWorkspaceSecretChanges } from "../maintenance.js";
import { workspaceSchema } from "../projects.js";
import { secretAccountSchema, secretCredentialSyncSchema, secretScopeParamsSchema, secretScopeSchema } from "../schemas.js";
import { app } from "../state.js";

app.get("/api/secrets", async (_request, response, next) => {
  try { response.json({ accounts: await listSecretAccounts() }); } catch (error) { next(error); }
});
app.post("/api/secrets/accounts", async (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    const account = await saveSecretAccount(secretAccountSchema.omit({ id: true }).parse(request.body));
    const syncResults = await replicateSecretAccount(account, session.userId);
    response.status(201).json({ accounts: await listSecretAccounts(), account, ...(syncResults ? { syncResults } : {}) });
  } catch (error) { next(error); }
});
app.put("/api/secrets/accounts/:accountId", async (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    const account = await saveSecretAccount({ ...secretAccountSchema.omit({ id: true }).parse(request.body), id: z.string().uuid().parse(request.params.accountId) });
    const syncResults = await replicateSecretAccount(account, session.userId);
    response.json({ accounts: await listSecretAccounts(), account, ...(syncResults ? { syncResults } : {}) });
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
    const session = response.locals.authSession as AuthSession;
    const scope = secretScopeParamsSchema.parse(request.params);
    const payload = secretScopeSchema.parse(request.body);
    const previous = await getScopeSecretAccounts(scope.scopeType, scope.scopeId);
    await setScopeSecretAccounts(scope.scopeType, scope.scopeId, payload.accountIds);
    const changed = [...new Set([...previous.accountIds, ...payload.accountIds])].filter((id) => previous.accountIds.includes(id) !== payload.accountIds.includes(id));
    if (scope.scopeType === "workspace") await replicateWorkspaceSecretChanges(changed, session.userId);
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

// Replaces POST /api/github-auth/sync: replication is now a per-account opt-in, so a sync
// pushes exactly the accounts the user marked to replicate.
app.post("/api/secrets/sync", async (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    const { peerIds } = secretCredentialSyncSchema.parse(request.body);
    const peers = await listClusterPeers();
    const selected = peerIds.map((peerId) => peers.find((peer) => peer.id === peerId));
    const missing = peerIds.filter((_, index) => !selected[index]);
    if (missing.length) {
      sendError(response, 404, `Unknown node: ${missing.join(", ")}`);
      return;
    }
    await enqueueSecretCredentialSync(peerIds, session.userId);
    const results = await Promise.all((selected as ClusterPeer[]).map(async (peer) => {
      const outcome = await pushSecretCredentialsToPeer(peer);
      return { peerId: peer.id, name: peer.name, delivered: outcome.delivered, ...(outcome.error ? { error: outcome.error } : {}) };
    }));
    response.json({ results });
  } catch (error) {
    next(error);
  }
});
