import { z } from "zod";
import { ensureManagedHome } from "../../managed-home.js";
import { deleteSecretAccount, getScopeSecretAccounts, listSecretAccounts, saveSecretAccount, setScopeSecretAccounts } from "../../secrets.js";
import { getSettings } from "../../settings.js";
import { deleteWorkspace, listWorkspaces, saveWorkspace } from "../../store.js";
import { workspaceSchema } from "../projects.js";
import { secretAccountSchema, secretScopeParamsSchema, secretScopeSchema } from "../schemas.js";
import { app } from "../state.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { getClusterNode } from "../../cluster.js";
import { ensureSecretSharingSchema, secretGrants, setSecretGrants } from "../scoped-credentials.js";
import { ClusterV2HttpError } from "../../cluster-v2-errors.js";
import { mayShareProject } from "../sharing-files.js";
import { generateSshKeyPair } from "../../github-credentials.js";

app.get("/api/secrets/destinations", async (_request, response, next) => {
  try {
    const db = await clusterV2Database(), local = (await getClusterNode()).id;
    ensureSecretSharingSchema(db);
    response.json({ clusters: (db.prepare(`SELECT c.id,c.name FROM sharing_clusters c JOIN sharing_memberships m ON m.cluster_id=c.id WHERE m.node_id=? AND c.closed=0 ORDER BY c.name`).all(local) as Array<{id:string;name:string}>).map(cluster => ({ ...cluster, nodes: db.prepare(`SELECT m.node_id id,COALESCE(e.name,m.node_id) name FROM sharing_memberships m LEFT JOIN cluster_v2_peer_endpoints e ON e.node_id=m.node_id AND e.context_id=m.cluster_id WHERE m.cluster_id=? AND m.node_id<>? GROUP BY m.node_id ORDER BY name`).all(cluster.id,local) })) });
  } catch (error) { next(error); }
});
app.get("/api/clusters/:clusterId/secrets", async (request, response, next) => {
  try {
    const db=await clusterV2Database(),local=(await getClusterNode()).id,clusterId=z.string().uuid().parse(request.params.clusterId);
    ensureSecretSharingSchema(db);
    if(!db.prepare('SELECT 1 FROM sharing_memberships WHERE cluster_id=? AND node_id=?').get(clusterId,local)) {response.status(403).json({error:'Not a member of this cluster'});return;}
    const accounts=await listSecretAccounts();
    const shared=accounts.filter(account=>!account.readOnly && (db.prepare('SELECT 1 FROM cluster_v2_secret_grants WHERE account_id=? AND cluster_id=?').get(account.id,clusterId) || db.prepare(`SELECT 1 FROM secret_assignments s JOIN cluster_v2_share_selections sh ON sh.resource_id=s.scope_id AND sh.kind='workspace' WHERE s.account_id=? AND s.scope_type='workspace' AND sh.cluster_id=?`).get(account.id,clusterId) || account.replicate && db.prepare(`SELECT 1 FROM secret_assignments s JOIN sharing_resource_shares sh ON sh.resource_id=s.scope_id AND sh.kind='project' WHERE s.account_id=? AND s.scope_type='project' AND sh.cluster_id=?`).get(account.id,clusterId))).map(account=>({id:account.id,label:account.label}));
    const received=accounts.filter(account=>{
      if(!account.readOnly)return false;
      const copy=db.prepare('SELECT grants,scopes FROM cluster_v2_scoped_secret_copies WHERE account_id=?').get(account.id) as {grants:string;scopes:string}|undefined;
      if(!copy)return false;
      const grants=JSON.parse(copy.grants) as Array<{clusterId:string}>;
      const scopes=JSON.parse(copy.scopes) as Array<{projectIds:string[];clusterIds?:string[]}>;
      return grants.some(grant=>grant.clusterId===clusterId) || scopes.some(scope=>scope.clusterIds
        ? scope.clusterIds.includes(clusterId) && scope.projectIds.some(id=>mayShareProject(db,local,account.ownerNodeId!,id))
        : scope.projectIds.some(id=>mayShareProject(db,local,account.ownerNodeId!,id) && db.prepare("SELECT 1 FROM sharing_resource_shares WHERE kind='project' AND resource_id=? AND cluster_id=?").get(id,clusterId)));
    }).map(account=>({id:account.id,label:account.label,ownerNodeId:account.ownerNodeId}));
    response.json({shared,received});
  } catch(error){next(error);}
});
app.get("/api/secrets/accounts/:accountId/sharing", async (request, response, next) => {
  try { response.json({ grants: secretGrants(await clusterV2Database(), (await getClusterNode()).id, z.string().uuid().parse(request.params.accountId)) }); } catch (error) { if (error instanceof ClusterV2HttpError) { response.status(error.statusCode).json({ error: error.message }); return; } next(error); }
});
app.put("/api/secrets/accounts/:accountId/sharing", async (request, response, next) => {
  try {
    const input = z.object({ grants: z.array(z.object({ clusterId: z.string().uuid(), nodeId: z.string().min(1).nullable() }).strict()).max(1000) }).strict().parse(request.body);
    response.json({ grants: setSecretGrants(await clusterV2Database(), (await getClusterNode()).id, z.string().uuid().parse(request.params.accountId), input.grants) });
  } catch (error) { if (error instanceof ClusterV2HttpError) { response.status(error.statusCode).json({ error: error.message }); return; } next(error); }
});
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
  } catch (error) { if (error instanceof ClusterV2HttpError) { response.status(error.statusCode).json({ error: error.message }); return; } next(error); }
});
app.delete("/api/secrets/accounts/:accountId", async (request, response, next) => {
  try { await deleteSecretAccount(z.string().uuid().parse(request.params.accountId)); response.json({ accounts: await listSecretAccounts() }); } catch (error) { if (error instanceof ClusterV2HttpError) { response.status(error.statusCode).json({ error: error.message }); return; } next(error); }
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

app.post("/api/secrets/github-ssh-key", (_request, response, next) => {
  try { response.json(generateSshKeyPair("joint-bob")); } catch (error) { next(error); }
});
