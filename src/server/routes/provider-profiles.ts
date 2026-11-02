import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthSession } from "../../auth.js";
import { getProject, listWorkspaces } from "../../store.js";
import { latestConversationSegment } from "../../conversation-records.js";
import { getClusterNode } from "../../cluster.js";
import { pinnedClusterPublicKey, verifyClusterMessage } from "../../cluster-identity.js";
import { isTrustedTwin } from "../../cluster-sharing-policy.js";
import { accountInCluster } from "../../cluster-accounts.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { clusterManager, signedPost } from "../cluster-v2.js";
import { ClusterV2HttpError } from "../../cluster-v2-errors.js";
import { createProviderProfile, deleteProviderProfile, listProviderProfiles, listProviderProfileSelections, providerProfile, providerProfileById, profileSelectionSchema, setProviderProfileSelection, listSubscriptionSelections, listAccessibleProviderProfiles, setProviderProfileShared, twinProviderProfile } from "../../provider-profiles/store.js";
import { createSubscriptionPool, deleteSubscriptionPool, getSubscriptionPool, listSubscriptionPools, setSubscriptionPoolSelection, updateSubscriptionPool, type SubscriptionPool } from "../../provider-profiles/pools.js";
import { poolProfileProviderSchema, applyClusterSubscriptionPoolEvent, assignedClusterPoolsForOwner, clusterPoolProfileAuthorized, getClusterSubscriptionPool, parseClusterSubscriptionPoolAssignment, setClusterSubscriptionPool, type ClusterSubscriptionPoolManifest } from "../../provider-profiles/pool-sharing.js";
import { localProfileCredential, logoutProfile, profileAvailability, profileLoginState, startProfileLogin } from "../../provider-profiles/service.js";
import { borrowTwinCredential, TWIN_PROFILE_TOKEN_PATH } from "../../provider-profiles/twin-login.js";
import { profileLogins } from "../../provider-profiles/login.js";
import { kiroProfileLoginStatus, cancelKiroProfileLogin } from "../../kiro-profiles/native.js";
import { piProfileProviders, startPiProfileLogin, removePiProfileProvider } from "../../provider-profiles/pi-credentials.js";
import { profileBusy } from "../../provider-profiles/execution.js";
import { sendError } from "../http-auth.js";
import { app } from "../state.js";

const idSchema = z.string().uuid();
const clusterTokenRequestSchema = z.object({ clusterId: idSchema, poolId: idSchema, profileId: idSchema }).strict();
const clusterTokenAuthorizationSchema = z.object({
  authorization: z.object({ clusterId: idSchema, poolOwnerNodeId: idSchema, poolId: idSchema, profileId: idSchema, requesterNodeId: idSchema, authorized: z.literal(true) }).strict(),
  signerNodeId: idSchema,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
}).strict();
const owner = (response: Response) => (response.locals.authSession as AuthSession).accountId;
function profile(request: Request, response: Response) { return providerProfile(owner(response), idSchema.parse(request.params.id)); }
function route(work: (request: Request, response: Response) => unknown) {
  return async (request: Request, response: Response, next: NextFunction) => {
    try { await work(request, response); }
    catch (error) {
      if (error instanceof z.ZodError) { sendError(response, 400, "Invalid provider profile request"); return; }
      if (error instanceof Error && /login method unavailable|Expected Pi profile|Choose a provider/.test(error.message)) { sendError(response, 400, error.message); return; }
      if (error instanceof Error && /Kiro profiles.*standalone/.test(error.message)) { sendError(response, 400, error.message); return; }
      if (error instanceof ClusterV2HttpError) { sendError(response, error.statusCode, error.message); return; }
      if (error instanceof Error && /not found/i.test(error.message)) { sendError(response, 404, error.message); return; }
      if (error instanceof Error && /selection|assignment|assigned|in progress|busy|pending sign-in|already signed in|finishing|automation only/i.test(error.message)) { sendError(response, 409, error.message); return; }
      next(error);
    }
  };
}
function loginStatus(selected: ReturnType<typeof providerProfile>) {
  return selected.provider === "kiro" ? kiroProfileLoginStatus(selected) : profileLogins.status(selected.owner, selected.id);
}
function editable(id: string): void {
  if (profileBusy(id)) throw new Error("This profile is busy. Wait for its current turn to finish.");
}

function poolManifest(ownerId: string, pool: SubscriptionPool): ClusterSubscriptionPoolManifest {
  return {
    poolId: pool.id,
    name: pool.name,
    fallbackModels: pool.fallbackModels,
    members: pool.members.map(({ profileId, position }) => {
      const profile = providerProfile(ownerId, profileId);
      return { profileId, provider: poolProfileProviderSchema.parse(profile.provider), label: profile.label, position };
    }),
  };
}

function acceptPoolAssignment(db: Awaited<ReturnType<typeof clusterV2Database>>, managerNodeId: string, clusterId: string, input: unknown): void {
  const result = z.object({ assignment: z.unknown(), signerNodeId: idSchema, signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict().parse(input);
  const assignment = parseClusterSubscriptionPoolAssignment(result.assignment), key = pinnedClusterPublicKey(db, managerNodeId);
  if (!key || result.signerNodeId !== managerNodeId || assignment.clusterId !== clusterId || assignment.originNodeId !== managerNodeId
    || !verifyClusterMessage(key, "provider-pool-assignment", JSON.stringify(assignment), result.signature)) throw new ClusterV2HttpError(503, "Cluster peer returned an invalid pool assignment");
  const event = { id: randomUUID(), originNodeId: managerNodeId, entityType: "provider.poolAssignment", entityKey: clusterId, operation: "upsert", payload: assignment, createdAt: assignment.updatedAt };
  if (!applyClusterSubscriptionPoolEvent(db, event)) throw new ClusterV2HttpError(503, "Cluster peer returned a stale pool assignment");
}

async function pushPoolManifest(): Promise<void> {
  try { const { flushHubDeliveries } = await import("../cluster-hubs.js"); await flushHubDeliveries(); }
  catch (error) { console.warn("Cluster pool manifest push failed", error); }
}

async function refreshAssignedPoolManifests(ownerId: string, pool: SubscriptionPool): Promise<void> {
  const local = await getClusterNode(), db = await clusterV2Database(), manifest = poolManifest(ownerId, pool);
  for (const assignment of assignedClusterPoolsForOwner(db, local.id, pool.id)) {
    const manager = clusterManager(db, assignment.clusterId);
    if (manager !== local.id) {
      acceptPoolAssignment(db, manager, assignment.clusterId, await signedPost<unknown>(db, local.id, manager, assignment.clusterId, "/api/cluster/v2/subscription-pools/assign", {
        clusterId: assignment.clusterId, expectedEpoch: assignment.managerEpoch, poolOwnerNodeId: local.id, manifest,
      }));
      continue;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      setClusterSubscriptionPool(db, local.id, assignment.clusterId, local.id, manifest, assignment.managerEpoch);
      db.exec("COMMIT");
      await pushPoolManifest();
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
}

app.get("/api/provider-profiles/available", route((request, response) => {
  const usage = z.enum(["interactive", "automation"]).parse(request.query.usage ?? "interactive");
  response.json({ profiles: listAccessibleProviderProfiles(owner(response), usage) });
}));
app.put("/api/provider-profiles/:id/sharing", route((request, response) => {
  const selected = profile(request, response); editable(selected.id);
  const { shared } = z.object({ shared: z.boolean() }).strict().parse(request.body);
  response.json({ profile: setProviderProfileShared(owner(response), selected.id, shared) });
}));
app.get("/api/provider-profiles", route((_request, response) => {
  response.json({ profiles: listProviderProfiles(owner(response)), selections: listSubscriptionSelections(owner(response)) });
}));
app.post("/api/provider-profiles", route((request, response) => {
  response.status(201).json({ profile: createProviderProfile(owner(response), request.body) });
}));
app.get("/api/provider-profiles/pools", route((_request, response) => {
  response.json({ pools: listSubscriptionPools(owner(response)) });
}));
app.post("/api/provider-profiles/pools", route((request, response) => {
  response.status(201).json({ pool: createSubscriptionPool(owner(response), request.body) });
}));
app.put("/api/provider-profiles/pools/:id", route(async (request, response) => {
  const accountId = owner(response), pool = updateSubscriptionPool(accountId, idSchema.parse(request.params.id), request.body);
  await refreshAssignedPoolManifests(accountId, pool);
  response.json({ pool });
}));
app.delete("/api/provider-profiles/pools/:id", route(async (request, response) => {
  const accountId = owner(response), poolId = idSchema.parse(request.params.id);
  const pool = getSubscriptionPool(accountId, poolId), local = await getClusterNode(), db = await clusterV2Database();
  if (assignedClusterPoolsForOwner(db, local.id, pool.id).length) throw new Error("Remove this pool's cluster assignments before deleting it");
  deleteSubscriptionPool(accountId, poolId);
  response.json({ ok: true });
}));
app.get("/api/provider-profiles/:id/providers", route(async (request, response) => {
  response.json({ providers: await piProfileProviders(profile(request, response)) });
}));
app.post("/api/provider-profiles/:id/providers/:providerId/login", route(async (request, response) => {
  const selected = profile(request, response); editable(selected.id);
  if (loginStatus(selected)?.state === "waiting") throw new Error("A login is in progress");
  const { methodId } = z.object({ methodId: z.enum(["api_key", "oauth"]) }).strict().parse(request.body);
  const providerId = z.string().min(1).max(200).parse(request.params.providerId);
  response.json({ login: await startPiProfileLogin(owner(response), selected.id, providerId, methodId) });
}));
app.delete("/api/provider-profiles/:id/providers/:providerId", route(async (request, response) => {
  const selected = profile(request, response); editable(selected.id);
  if (loginStatus(selected)?.state === "waiting") throw new Error("A login is in progress");
  await removePiProfileProvider(selected, z.string().min(1).max(200).parse(request.params.providerId));
  response.json({ ok: true });
}));
app.get("/api/provider-profiles/:id/status", route(async (request, response) => {
  const selected = profile(request, response);
  response.json({ ...await profileAvailability(selected), provider: selected.provider, login: loginStatus(selected) ?? null });
}));
app.get("/api/provider-profiles/:id/login", route((request, response) => {
  const selected = profile(request, response);
  response.json({ login: loginStatus(selected) ?? { state: "cancelled", message: "No sign-in is in progress on this node" } });
}));
app.post("/api/provider-profiles/:id/login", route(async (request, response) => {
  const selected = profile(request, response); editable(selected.id);
  response.json({ login: await startProfileLogin(owner(response), selected.id) });
}));
app.put("/api/provider-profiles/:id/login", route((request, response) => {
  const selected = profile(request, response);
  const body = z.object({ answer: z.string().trim().min(1).max(8192) }).strict().parse(request.body);
  profileLogins.answer(owner(response), selected.id, body.answer);
  response.json({ ok: true });
}));
app.delete("/api/provider-profiles/:id/login", route(async (request, response) => {
  const selected = profile(request, response);
  if (selected.provider === "kiro") await cancelKiroProfileLogin(selected);
  else profileLogins.cancel(owner(response), selected.id);
  response.json({ ok: true });
}));
app.post("/api/provider-profiles/:id/logout", route(async (request, response) => {
  const selected = profile(request, response); editable(selected.id);
  if (loginStatus(selected)?.state === "waiting") throw new Error("A login is in progress");
  await logoutProfile(selected);
  response.json({ ok: true });
}));
app.delete("/api/provider-profiles/:id", route(async (request, response) => {
  const selected = profile(request, response); editable(selected.id);
  if (listProviderProfileSelections(owner(response)).some((entry) => entry.profileId === selected.id)) throw new Error("Remove this profile's selections before deleting it");
  if (loginStatus(selected)?.state === "waiting") throw new Error("A login is in progress");
  const login = await profileLoginState(selected);
  if (!login.signedIn && login.message !== "Sign in on this node") throw new Error(login.message);
  await logoutProfile(selected);
  deleteProviderProfile(owner(response), selected.id);
  response.json({ ok: true });
}));

async function scopeAllowed(selection: z.infer<typeof profileSelectionSchema>): Promise<boolean> {
  if (selection.scope === "default") return true;
  if (selection.scope === "workspace") return (await listWorkspaces()).some((item) => item.id === selection.scopeId);
  let projectId = selection.scopeId;
  if (selection.scope === "conversation") {
    let target: unknown;
    try { target = JSON.parse(selection.scopeId); } catch { return false; }
    const [id, conversationId] = z.tuple([z.string().min(1), z.string().min(1)]).parse(target);
    projectId = id;
    const record = await latestConversationSegment(conversationId);
    if (!record || record.projectId !== projectId) return false;
  }
  const project = await getProject(projectId);
  return Boolean(project);
}
app.put("/api/provider-profiles/selection", route(async (request, response) => {
  const selection = profileSelectionSchema.parse(request.body);
  if (!await scopeAllowed(selection)) { sendError(response, 404, "Scope not found or not accessible to this account"); return; }
  if (selection.poolId) setSubscriptionPoolSelection(owner(response), selection);
  else setProviderProfileSelection(owner(response), selection);
  response.json({ selections: listSubscriptionSelections(owner(response)) });
}));

async function authorizeClusterToken(db: Awaited<ReturnType<typeof clusterV2Database>>, localNodeId: string, requesterNodeId: string, input: z.infer<typeof clusterTokenRequestSchema>): Promise<void> {
  const manager = clusterManager(db, input.clusterId);
  if (manager === localNodeId) return;
  const payload = { ...input, poolOwnerNodeId: localNodeId, requesterNodeId };
  const reply = clusterTokenAuthorizationSchema.parse(await signedPost<unknown>(db, localNodeId, manager, input.clusterId, "/api/cluster/v2/subscription-pools/authorize-token", payload));
  const expected = { clusterId: input.clusterId, poolOwnerNodeId: localNodeId, poolId: input.poolId, profileId: input.profileId, requesterNodeId, authorized: true }, key = pinnedClusterPublicKey(db, manager);
  if (!key || reply.signerNodeId !== manager || JSON.stringify(reply.authorization) !== JSON.stringify(expected)
    || !verifyClusterMessage(key, "provider-pool-token-authorization", JSON.stringify(reply.authorization), reply.signature)) {
    throw new ClusterV2HttpError(403, "Cluster manager did not authorize this pool token");
  }
}

app.post("/api/cluster/v2/subscription-pools/token", route(async (request, response) => {
  const sender = response.locals.machineProtocol === 2 && typeof response.locals.machineNodeId === "string" ? response.locals.machineNodeId : undefined;
  if (!sender) { sendError(response, 401, "Unauthorized"); return; }
  const input = clusterTokenRequestSchema.parse(request.body), local = await getClusterNode(), db = await clusterV2Database();
  if (!clusterPoolProfileAuthorized(db, input.clusterId, local.id, sender, input.poolId, input.profileId)) { sendError(response, 403, "Forbidden"); return; }
  const selected = providerProfileById(input.profileId), pool = getSubscriptionPool(selected.owner, input.poolId);
  if (selected.shared || !pool.members.some(({ profileId }) => profileId === input.profileId) || !accountInCluster(db, selected.owner, input.clusterId)) { sendError(response, 403, "Forbidden"); return; }
  await authorizeClusterToken(db, local.id, sender, input);
  try {
    const credential = await localProfileCredential(selected) ?? await borrowTwinCredential(selected);
    response.json({ credential: credential ? { type: "oauth", access: credential.access, refresh: "", expires: credential.expires } : null });
  } catch (error) { sendError(response, 409, error instanceof Error ? error.message : "Sign-in unavailable on this node"); }
}));

/** A twin without its own sign-in borrows a short-lived token. The refresh token stays here. */
app.post(TWIN_PROFILE_TOKEN_PATH, route(async (request, response) => {
  const sender = response.locals.machineProtocol === 2 && typeof response.locals.machineNodeId === "string" ? response.locals.machineNodeId : undefined;
  if (!sender) { sendError(response, 401, "Unauthorized"); return; }
  if (!isTrustedTwin(await clusterV2Database(), (await getClusterNode()).id, sender)) { sendError(response, 403, "Forbidden"); return; }
  const body = z.object({ profileId: idSchema, check: z.literal(true).optional() }).strict().parse(request.body);
  const selected = twinProviderProfile(body.profileId);
  if (!selected) { sendError(response, 404, "Provider profile not found on this node"); return; }
  if (selected.provider === "kiro") { sendError(response, 409, "Kiro profiles are standalone; their credentials stay on this node"); return; }
  if (body.check) { response.json({ signedIn: (await profileLoginState(selected)).signedIn }); return; }
  try {
    const credential = await localProfileCredential(selected);
    response.json({ credential: credential ? { ...credential, refresh: "" } : null });
  } catch (error) { sendError(response, 409, error instanceof Error ? error.message : "Sign-in unavailable on this node"); }
}));
