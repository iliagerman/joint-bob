import { randomBytes } from "node:crypto";
import { z } from "zod";
import { mfaStatus } from "../../auth.js";
import { getClusterNode } from "../../cluster.js";
import { clusterPublicKeyFingerprint } from "../../cluster-identity.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { advertisedNodeUrl, relayRuntimeInstance, relayServerInstance, relayServingChanged, startRelay } from "../../relay/index.js";
import { setOtherUsersMayUsePhone } from "../../relay/phone-policy.js";
import { normalizeRelayOrigin, phoneAddress, RELAY_NAME_PATTERN } from "../../relay/protocol.js";
import { RelayServerError } from "../../relay/relay-server.js";
import { enrollLink, LOCAL_RELAY_ID, RelayRuntimeError } from "../../relay/runtime.js";
import {
  audit,
  createRelayToken,
  listAudit,
  listRelayMachines,
  listRelayTokens,
  machineUsage,
  otherUsersPhoneSignIn,
  relayMachine,
  RelayStoreError,
  revokeRelayToken,
  saveServingSettings,
  servingSettings
} from "../../relay/store.js";
import { Feature, requireFeature, sendError } from "../http-auth.js";
import { app } from "../state.js";
app.use("/api/relays", requireFeature(Feature.SETTINGS));
app.use("/api/relay", requireFeature(Feature.SETTINGS));
const uuid = z.string().uuid();
const page = z.object({ page: z.coerce.number().int().positive().max(1e5).default(1), pageSize: z.coerce.number().int().positive().max(50).default(10) });
function actor(response) {
  return response.locals.authSession?.username ?? "operator";
}
function handle(work) {
  return async (request, response, next) => {
    try {
      await startRelay();
      await work(request, response);
    } catch (error) {
      if (error instanceof z.ZodError) {
        sendError(response, 400, error.errors.map((issue) => issue.message).join(", "));
        return;
      }
      if (error instanceof RelayServerError || error instanceof RelayRuntimeError || error instanceof RelayStoreError) {
        sendError(response, error.statusCode, error.message);
        return;
      }
      next(error);
    }
  };
}
function knownName(db, nodeId) {
  for (const table of ["cluster_v2_peer_endpoints", "cluster_v2_membership_nodes"]) {
    try {
      const row = db.prepare(`SELECT name FROM ${table} WHERE node_id=? LIMIT 1`).get(nodeId);
      if (row?.name) return row.name;
    } catch {
    }
  }
  return null;
}
function phoneDirectory(db, membershipId, origin) {
  const runtime = relayRuntimeInstance();
  return (runtime?.phoneDirectory(membershipId) ?? []).filter((entry) => entry.phone).map((entry) => ({
    nodeId: entry.nodeId,
    kind: entry.kind,
    address: phoneAddress(origin, entry.name),
    label: entry.kind === "this" ? "This machine" : knownName(db, entry.nodeId) ?? (entry.kind === "relay" ? "The relay machine" : entry.name)
  }));
}
async function membershipView(response) {
  const runtime = relayRuntimeInstance();
  const server = relayServerInstance();
  const node = await getClusterNode();
  const db = await clusterV2Database();
  const session = response.locals.authSession;
  const relays = (runtime?.status() ?? []).map((item) => ({
    id: item.id,
    origin: item.origin,
    fingerprint: item.fingerprint,
    environment: item.environment,
    name: item.name,
    status: item.status,
    pairingCode: item.pairingCode,
    phoneSignIn: item.phoneSignIn,
    lastError: item.lastError,
    lastConnectedAt: item.lastConnectedAt,
    connected: item.connected,
    onlinePeers: item.onlinePeers,
    phoneAddress: item.name && item.status === "admitted" ? phoneAddress(item.origin, item.name) : null,
    phoneDirectory: item.connected ? phoneDirectory(db, item.id, item.origin) : []
  }));
  const self = server?.enabled ? relayMachine(db, node.id) : void 0;
  const local = server?.enabled && self ? {
    id: LOCAL_RELAY_ID,
    origin: server.origin,
    environment: server.environment,
    name: self.name,
    phoneSignIn: self.phoneSignIn,
    phoneAddress: phoneAddress(server.origin, self.name),
    onlinePeers: runtime?.localStatus().onlinePeers ?? 0,
    phoneDirectory: phoneDirectory(db, LOCAL_RELAY_ID, server.origin)
  } : null;
  return {
    relays,
    local,
    directUrl: node.url,
    advertisedUrl: await advertisedNodeUrl(node),
    mfaEnabled: session ? mfaStatus(session.userId).enabled : false,
    otherUsersPhoneSignIn: otherUsersPhoneSignIn(db)
  };
}
app.get("/api/relays", handle(async (_request, response) => {
  response.json(await membershipView(response));
}));
const addSchema = z.union([
  z.object({ link: z.string().trim().min(1).max(2e3) }).strict(),
  z.object({ origin: z.string().trim().min(1).max(500) }).strict()
]);
app.post("/api/relays", handle(async (request, response) => {
  const runtime = relayRuntimeInstance();
  if (!runtime) throw new RelayRuntimeError(503, "Relays are starting");
  const body = addSchema.parse(request.body);
  const added = "link" in body ? runtime.addWithToken(body.link) : runtime.requestAccess(body.origin);
  response.status(201).json({ relay: { id: added.id, origin: added.origin } });
}));
app.post("/api/relays/:id/reconnect", handle((request, response) => {
  relayRuntimeInstance()?.reconnect(uuid.parse(request.params.id));
  response.status(204).end();
}));
const machineSettingsSchema = z.object({ otherUsersPhoneSignIn: z.boolean() }).strict();
app.put("/api/relays/settings", handle(async (request, response) => {
  const body = machineSettingsSchema.parse(request.body);
  setOtherUsersMayUsePhone(await clusterV2Database(), body.otherUsersPhoneSignIn);
  response.json(await membershipView(response));
}));
const patchSchema = z.object({ phoneSignIn: z.boolean() }).strict();
app.patch("/api/relays/:id", handle(async (request, response) => {
  const runtime = relayRuntimeInstance();
  if (!runtime) throw new RelayRuntimeError(503, "Relays are starting");
  const id = request.params.id === LOCAL_RELAY_ID ? LOCAL_RELAY_ID : uuid.parse(request.params.id);
  runtime.setPhoneSignIn(id, patchSchema.parse(request.body).phoneSignIn);
  response.json(await membershipView(response));
}));
app.delete("/api/relays/:id", handle((request, response) => {
  relayRuntimeInstance()?.leave(uuid.parse(request.params.id));
  response.status(204).end();
}));
app.get("/api/relay/serving", handle(async (_request, response) => {
  const db = await clusterV2Database();
  const server = relayServerInstance();
  const settings = servingSettings(db);
  response.json({
    settings: { ...settings, monthlyCapGb: settings.monthlyCapBytes / 1e9 },
    fingerprint: server?.fingerprint ?? null,
    connected: server?.connectedCount ?? 0,
    pending: listRelayMachines(db, ["pending"], 0, 1).total,
    admitted: listRelayMachines(db, ["admitted", "suspended"], 0, 1).total
  });
}));
const servingSchema = z.object({
  enabled: z.boolean(),
  origin: z.string().trim().max(500),
  environment: z.string().trim().max(40),
  requestsEnabled: z.boolean(),
  maxMachines: z.number().int().min(1).max(1e4),
  monthlyCapGb: z.number().min(0).max(1e6),
  alertTopic: z.string().trim().regex(/^(?:[A-Za-z0-9_-]{1,64})?$/, "ntfy topics use letters, digits, - and _"),
  ownMachinesOnly: z.boolean().default(false)
}).strict();
app.put("/api/relay/serving", handle(async (request, response) => {
  const body = servingSchema.parse(request.body);
  let origin = "";
  if (body.origin) {
    try {
      origin = normalizeRelayOrigin(body.origin);
    } catch {
      throw new RelayServerError(400, "The relay address must be an HTTPS origin, like https://relay.example.com");
    }
  }
  if (body.enabled && !origin) throw new RelayServerError(400, "Set the relay's public HTTPS address before turning it on");
  const db = await clusterV2Database();
  saveServingSettings(db, {
    enabled: body.enabled,
    origin,
    environment: body.environment,
    requestsEnabled: body.requestsEnabled,
    maxMachines: body.maxMachines,
    monthlyCapBytes: Math.round(body.monthlyCapGb * 1e9),
    alertTopic: body.alertTopic,
    ownMachinesOnly: body.ownMachinesOnly
  });
  await relayServingChanged();
  response.status(204).end();
}));
app.post("/api/relay/serving/check", handle(async (_request, response) => {
  const server = relayServerInstance();
  if (!server?.enabled) throw new RelayServerError(409, "Turn relay serving on first");
  const check = async (url, expect) => {
    try {
      const answer = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(8e3) });
      await answer.body?.cancel();
      return expect(answer) ? { ok: true, error: null } : { ok: false, error: `Unexpected answer (HTTP ${answer.status})` };
    } catch (error) {
      const cause = error.cause;
      return { ok: false, error: cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : "Unreachable") };
    }
  };
  const origin = new URL(server.origin);
  const probe = `${origin.protocol}//jb-check-${randomBytes(4).toString("hex")}.${origin.host}/`;
  const [address, wildcard] = await Promise.all([
    check(`${server.origin}/api/health`, (answer) => answer.ok),
    check(probe, (answer) => answer.status === 404 && answer.headers.get("x-joint-bob-relay") === "gateway")
  ]);
  response.json({ address, wildcard });
}));
const statusFilter = z.enum(["pending", "admitted", "suspended", "revoked", "all"]).default("all");
app.get("/api/relay/serving/machines", handle(async (request, response) => {
  const query = page.extend({ status: statusFilter }).parse(request.query);
  const db = await clusterV2Database();
  const server = relayServerInstance();
  const statuses = query.status === "all" ? ["pending", "admitted", "suspended"] : [query.status];
  const { machines, total } = listRelayMachines(db, statuses, (query.page - 1) * query.pageSize, query.pageSize);
  response.json({
    total,
    machines: machines.map((machine) => ({
      nodeId: machine.nodeId,
      name: machine.name,
      status: machine.status,
      pairingCode: machine.pairingCode,
      admittedVia: machine.admittedVia,
      phoneSignIn: machine.phoneSignIn,
      lastSeenAt: machine.lastSeenAt,
      createdAt: machine.createdAt,
      fingerprint: fingerprintOf(machine.publicKey),
      online: server?.isOnline(machine.nodeId) ?? false,
      self: machine.nodeId === server?.nodeId,
      usageBytes: machineUsage(db, machine.nodeId),
      phoneAddress: server?.enabled && machine.status === "admitted" ? phoneAddress(server.origin, machine.name) : null
    }))
  });
}));
function fingerprintOf(publicKey) {
  try {
    return clusterPublicKeyFingerprint(publicKey);
  } catch {
    return null;
  }
}
const machineParams = z.object({ nodeId: uuid });
const machinePatch = z.object({
  name: z.string().trim().toLowerCase().regex(RELAY_NAME_PATTERN, "Names use lowercase letters, digits and inner hyphens, up to 63 characters").optional(),
  status: z.enum(["admitted", "suspended"]).optional()
}).strict();
app.patch("/api/relay/serving/machines/:nodeId", handle((request, response) => {
  const { nodeId } = machineParams.parse(request.params);
  const body = machinePatch.parse(request.body);
  const server = relayServerInstance();
  if (!server) throw new RelayServerError(503, "Relay is starting");
  if (body.name) server.rename(nodeId, body.name, actor(response));
  if (body.status) server.setStatus(nodeId, body.status, actor(response));
  response.status(204).end();
}));
app.delete("/api/relay/serving/machines/:nodeId", handle((request, response) => {
  const { nodeId } = machineParams.parse(request.params);
  relayServerInstance()?.setStatus(nodeId, "revoked", actor(response));
  response.status(204).end();
}));
app.post("/api/relay/serving/machines/:nodeId/approve", handle((request, response) => {
  const { nodeId } = machineParams.parse(request.params);
  const machine = relayServerInstance()?.approve(nodeId, actor(response));
  response.json({ name: machine?.name });
}));
app.post("/api/relay/serving/machines/:nodeId/decline", handle((request, response) => {
  const { nodeId } = machineParams.parse(request.params);
  relayServerInstance()?.decline(nodeId, actor(response));
  response.status(204).end();
}));
app.get("/api/relay/serving/tokens", handle(async (_request, response) => {
  response.json({ tokens: listRelayTokens(await clusterV2Database()) });
}));
const tokenSchema = z.object({
  label: z.string().trim().min(1).max(80),
  uses: z.number().int().min(1).max(1e3).default(1),
  ttlHours: z.number().min(0.25).max(24 * 90).default(24),
  suggestedName: z.string().trim().toLowerCase().regex(RELAY_NAME_PATTERN).optional()
}).strict();
app.post("/api/relay/serving/tokens", handle(async (request, response) => {
  const server = relayServerInstance();
  if (!server?.enabled) throw new RelayServerError(409, "Turn relay serving on before creating tokens");
  const body = tokenSchema.parse(request.body);
  const db = await clusterV2Database();
  const { token, secret } = createRelayToken(db, { label: body.label, uses: body.uses, ttlMs: body.ttlHours * 36e5, suggestedName: body.suggestedName });
  audit(db, "token-created", null, `"${token.label}" by ${actor(response)}`);
  response.status(201).json({ token, link: enrollLink(server.origin, server.fingerprint, secret) });
}));
app.delete("/api/relay/serving/tokens/:id", handle(async (request, response) => {
  const db = await clusterV2Database();
  if (!revokeRelayToken(db, uuid.parse(request.params.id))) throw new RelayServerError(404, "Token not found");
  audit(db, "token-revoked", null, `by ${actor(response)}`);
  response.status(204).end();
}));
app.get("/api/relay/serving/audit", handle(async (request, response) => {
  const query = page.parse(request.query);
  response.json(listAudit(await clusterV2Database(), (query.page - 1) * query.pageSize, query.pageSize));
}));
app.get("/enroll", (_request, response) => {
  response.type("html").set("Cache-Control", "no-store").send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Add this machine to a relay</title><body style="font-family:system-ui;margin:3rem auto;max-width:34rem;padding:0 1rem">
<h1>Add a machine to this relay</h1><p>This link admits one machine. On the machine you want to add, open Joint Bob, go to
<b>Settings \u2192 Cluster \u2192 Relays</b>, choose <b>Add relay</b>, and paste the whole link there.</p>
<p>Do not share the link more widely: anyone with it can add a machine until it is used or expires.</p></body>`);
});
