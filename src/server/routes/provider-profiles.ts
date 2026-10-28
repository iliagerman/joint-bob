import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthSession } from "../../auth.js";
import { getProject, listWorkspaces } from "../../store.js";
import { latestConversationSegment } from "../../conversation-records.js";
import { getClusterNode } from "../../cluster.js";
import { isTrustedTwin } from "../../cluster-sharing-policy.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { createProviderProfile, deleteProviderProfile, listProviderProfiles, listProviderProfileSelections, providerProfile, profileSelectionSchema, setProviderProfileSelection, listAccessibleProviderProfiles, setProviderProfileShared, twinProviderProfile } from "../../provider-profiles/store.js";
import { localProfileCredential, logoutProfile, profileAvailability, profileLoginState, startProfileLogin } from "../../provider-profiles/service.js";
import { TWIN_PROFILE_TOKEN_PATH } from "../../provider-profiles/twin-login.js";
import { profileLogins } from "../../provider-profiles/login.js";
import { profileBusy } from "../../provider-profiles/execution.js";
import { sendError } from "../http-auth.js";
import { app } from "../state.js";

const idSchema = z.string().uuid();
const owner = (response: Response) => (response.locals.authSession as AuthSession).accountId;
function profile(request: Request, response: Response) { return providerProfile(owner(response), idSchema.parse(request.params.id)); }
function route(work: (request: Request, response: Response) => unknown) {
  return async (request: Request, response: Response, next: NextFunction) => {
    try { await work(request, response); }
    catch (error) {
      if (error instanceof z.ZodError) { sendError(response, 400, "Invalid provider profile request"); return; }
      if (error instanceof Error && /not found/i.test(error.message)) { sendError(response, 404, error.message); return; }
      if (error instanceof Error && /selection|in progress|busy|pending sign-in|already signed in|finishing|automation only/i.test(error.message)) { sendError(response, 409, error.message); return; }
      next(error);
    }
  };
}
function editable(id: string): void {
  if (profileBusy(id)) throw new Error("This profile is busy. Wait for its current turn to finish.");
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
  response.json({ profiles: listProviderProfiles(owner(response)), selections: listProviderProfileSelections(owner(response)) });
}));
app.post("/api/provider-profiles", route((request, response) => {
  response.status(201).json({ profile: createProviderProfile(owner(response), request.body) });
}));
app.get("/api/provider-profiles/:id/status", route(async (request, response) => {
  const selected = profile(request, response);
  response.json({ ...await profileAvailability(selected), login: profileLogins.status(owner(response), selected.id) ?? null });
}));
app.get("/api/provider-profiles/:id/login", route((request, response) => {
  const selected = profile(request, response);
  response.json({ login: profileLogins.status(owner(response), selected.id) ?? { state: "cancelled", message: "No sign-in is in progress on this node" } });
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
app.delete("/api/provider-profiles/:id/login", route((request, response) => {
  const selected = profile(request, response);
  profileLogins.cancel(owner(response), selected.id);
  response.json({ ok: true });
}));
app.post("/api/provider-profiles/:id/logout", route(async (request, response) => {
  const selected = profile(request, response); editable(selected.id);
  if (profileLogins.status(owner(response), selected.id)?.state === "waiting") throw new Error("A login is in progress");
  await logoutProfile(selected);
  response.json({ ok: true });
}));
app.delete("/api/provider-profiles/:id", route(async (request, response) => {
  const selected = profile(request, response); editable(selected.id);
  if (listProviderProfileSelections(owner(response)).some((entry) => entry.profileId === selected.id)) throw new Error("Remove this profile's selections before deleting it");
  if (profileLogins.status(owner(response), selected.id)?.state === "waiting") throw new Error("A login is in progress");
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
  setProviderProfileSelection(owner(response), selection);
  response.json({ selections: listProviderProfileSelections(owner(response)) });
}));

/** A twin without its own sign-in borrows a short-lived token. The refresh token stays here. */
app.post(TWIN_PROFILE_TOKEN_PATH, route(async (request, response) => {
  const sender = response.locals.machineProtocol === 2 && typeof response.locals.machineNodeId === "string" ? response.locals.machineNodeId : undefined;
  if (!sender) { sendError(response, 401, "Unauthorized"); return; }
  if (!isTrustedTwin(await clusterV2Database(), (await getClusterNode()).id, sender)) { sendError(response, 403, "Forbidden"); return; }
  const body = z.object({ profileId: idSchema, check: z.literal(true).optional() }).strict().parse(request.body);
  const selected = twinProviderProfile(body.profileId);
  if (!selected) { sendError(response, 404, "Provider profile not found on this node"); return; }
  if (body.check) { response.json({ signedIn: (await profileLoginState(selected)).signedIn }); return; }
  try {
    const credential = await localProfileCredential(selected);
    response.json({ credential: credential ? { ...credential, refresh: "" } : null });
  } catch (error) { sendError(response, 409, error instanceof Error ? error.message : "Sign-in unavailable on this node"); }
}));
