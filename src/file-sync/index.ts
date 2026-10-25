import { AsyncResource } from "node:async_hooks";
import type { KeyObject } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { peerAway } from "../peer-presence.js";
import { onRelayPeersChanged } from "../relay/events.js";
import { settled, warnOnChange } from "../server/quiet-log.js";
import type { BridgeOptions, BridgeState, WorkerBridge } from "./bridge.js";
import { controlDatabase, ensureRevisionTriggers, fileSyncListenAddresses, holdsEngineProjects, listEngineRecords, listPhases, listSettingsRecords, readFileSyncConfig, readRevision, writeFileSyncConfig, type FileSyncConfig, type FileSyncConfigPatch } from "./control.js";
import { acceptablePeerOrigin, helloFileSync, notePeerFileSync, onPeerFileSyncChanged, onPeerPresent, parseFileSyncPart, peerFileSync, peerOrigins, peerSpecs, type HelloFileSync } from "./peers.js";
import type { ConfigureArgs, CoreEvent, DifferenceItem, ErrorItem, ListPage, RequestStats, ScanResult, ShareSpec, ShareStatus } from "./protocol.js";
import { ShareStatusStore } from "./status.js";
import { parseShareKey } from "./types.js";

/* Starts and stops the file sync worker and keeps it configured with the shares derived from
   node.db. Callers (server.ts, turn ends, project opens, /hello, Settings) never get an exception
   from here: failures are logged once per reason. Nothing loads the engine's heavier modules until
   it actually runs, so the hooks cost nothing on a node with file sync off. */

const STOP_BUDGET_MS = 2_000;
const FLUSH_TIMEOUT_MS = 60_000;
const PROJECT_OPEN_INTERVAL_MS = 30_000;
const DERIVE_COALESCE_MS = 250;
/** A hello and a relay's "back online" for the same peer usually come together; one pull is enough. */
const PRESENCE_COALESCE_MS = 5_000;

interface Modules {
  bridge: typeof import("./bridge.js");
  shares: typeof import("./shares.js");
  records: typeof import("./records.js");
  identity: typeof import("../cluster-identity.js");
  cluster: typeof import("../cluster.js");
  performance: typeof import("../server/performance-diagnostics.js");
}

interface Engine {
  db: DatabaseSync;
  nodeId: string;
  hostId: string;
  signingKey?: KeyObject;
  bridge: WorkerBridge;
  shares: ShareSpec[];
  desired?: ConfigureArgs;
  /** The desired state the current worker last accepted; unset until its first configure. */
  sent?: string;
  pushing: boolean;
  pushAgain: boolean;
  pushWaiters: Array<() => void>;
  revision: number;
  schema: number;
  deriveTimer?: NodeJS.Timeout;
  /** Direct origins the worker bound (configure answer, ready event): what /hello advertises. */
  origins: string[];
  /** Start, wake and join each ask peers once for what changed; a request while one runs folds into one more. */
  announceWanted: boolean;
  announceSlept: boolean;
  announcing: boolean;
  presence: Map<string, { at: number; origins: string }>;
  unsubscribe: Array<() => void>;
}

let modules: Promise<Modules> | undefined;
let engine: Engine | undefined;
/** The launch in flight and the lifecycle it belongs to: a stop in between makes it give up. */
let starting: { lifecycle: number; done: Promise<void> } | undefined;
let stopping: Promise<void> = Promise.resolve();
let lifecycle = 0;
/** Set by the first startFileSync, which runs once readiness allows cluster work and outside any request or background context. */
let scope: AsyncResource | undefined;
const statuses = new ShareStatusStore();
const projectOpenedAt = new Map<string, number>();
let workerOverride: Pick<BridgeOptions, "launch" | "workerData" | "dataDir"> | undefined;

function load(): Promise<Modules> {
  modules ??= Promise.all([import("./bridge.js"), import("./shares.js"), import("./records.js"), import("../cluster-identity.js"), import("../cluster.js"), import("../server/performance-diagnostics.js")])
    .then(([bridge, shares, records, identity, cluster, performance]) => ({ bridge, shares, records, identity, cluster, performance }));
  return modules;
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Network ops answer "unavailable" from a worker without a network part; that is not worth a warning. */
function quietly(key: string, what: string): (error: unknown) => void {
  return (error) => {
    if ((error as { code?: unknown })?.code === "unavailable") settled(key);
    else warnOnChange(key, `${what}: ${messageOf(error)}`);
  };
}

/** Work started from a request or a background pass runs in startup's context, so the worker's events and timers inherit neither. */
function neutral<T>(work: () => T): T { return scope ? scope.runInAsyncScope(work) : work(); }

/** Tests run the engine's main-thread half against a stand-in worker; undefined restores the real one. */
export function useFileSyncWorkerForTests(options: Pick<BridgeOptions, "launch" | "workerData" | "dataDir"> | undefined): void { workerOverride = options; }

/** From runClusterWork's one-time block; starts the worker only when file sync is enabled here. */
export async function startFileSync(): Promise<void> {
  scope ??= new AsyncResource("FileSync");
  try {
    const db = await controlDatabase();
    if (!readFileSyncConfig(db).enabled) return;
    await neutral(ensureRunning);
  } catch (error) {
    warnOnChange("fileSync:start", `File sync could not start: ${messageOf(error)}`);
  }
}

/** Within the shutdown budget: a stop op, then terminate. */
export async function stopFileSync(): Promise<void> {
  lifecycle++;
  const current = engine;
  engine = undefined;
  statuses.clear();
  projectOpenedAt.clear();
  if (!current) return;
  for (const unsubscribe of current.unsubscribe.splice(0)) unsubscribe();
  clearTimeout(current.deriveTimer);
  stopping = current.bridge.stop(STOP_BUDGET_MS).catch((error) => warnOnChange("fileSync:stop", `File sync did not stop cleanly: ${messageOf(error)}`));
  await stopping;
}

function ensureRunning(): Promise<void> {
  if (engine) return Promise.resolve();
  if (starting?.lifecycle === lifecycle) return starting.done;
  // A launch from before a stop gives up when it next looks; this one starts after it, never beside it.
  const previous = starting?.done ?? Promise.resolve();
  const generation = ++lifecycle;
  const done: Promise<void> = previous.catch(() => undefined).then(() => launch(generation)).finally(() => {
    if (starting?.done === done) starting = undefined;
  });
  starting = { lifecycle: generation, done };
  return done;
}

async function launch(generation: number): Promise<void> {
  if (generation !== lifecycle) return;
  const loaded = await load();
  const db = await controlDatabase();
  const nodeId = (await loaded.cluster.getClusterNode()).id;
  // A worker still stopping holds file-sync.db; the next one opens it after.
  await stopping;
  if (generation !== lifecycle) return;
  ensureRevisionTriggers(db);
  let signingKey: KeyObject | undefined;
  try { signingKey = loaded.identity.clusterPrivateKey(db, nodeId); }
  catch (error) { warnOnChange("fileSync:key", `File sync could not read this node's signing key, so its worker cannot reach peers directly: ${messageOf(error)}`); }
  const current: Engine = {
    db, nodeId, hostId: loaded.shares.fileSyncHostId(), signingKey, bridge: undefined as unknown as WorkerBridge, shares: [],
    pushing: false, pushAgain: false, pushWaiters: [], revision: -1, schema: readRevision(db).schema, origins: [],
    announceWanted: false, announceSlept: false, announcing: false, presence: new Map(), unsubscribe: [],
  };
  current.bridge = new loaded.bridge.WorkerBridge({
    nodeId,
    ...workerOverride,
    // A new worker knows nothing: it gets the whole desired state again, then asks peers what changed meanwhile.
    onStart: () => { current.sent = undefined; current.origins = []; current.announceWanted = true; void push(current); },
    onEvent: (event) => handleEvent(current, event),
  });
  engine = current;
  // The worker starts even so: its revision stays unknown, so the next 2 s pass derives again.
  await derive(current).catch((error) => warnOnChange("fileSync:derive", `File sync could not work out which folders to sync: ${messageOf(error)}`));
  if (engine !== current) return;
  current.unsubscribe.push(
    onRelayPeersChanged(() => requestDerive(current)),
    // Main had it as away: the worker stopped talking to it on that word (a relay answer marked away) and waits for this one.
    onPeerPresent((peer) => { requestDerive(current); fileSyncPeerPresent(peer, true); }),
    // New origins or capability reach the worker with the next configure.
    onPeerFileSyncChanged(() => requestDerive(current)),
  );
  current.bridge.start();
}

async function derive(current: Engine): Promise<void> {
  const loaded = await load();
  await loaded.performance.measureOperation("fileSync.derive", () => {
    const { revision } = readRevision(current.db);
    const config = readFileSyncConfig(current.db);
    const records = listSettingsRecords(current.db);
    const phases = new Map([...listPhases(current.db)].map(([projectId, record]) => [projectId, record.phase]));
    const shares = loaded.shares.deriveShares(current.db, { local: current.nodeId, shadowProjects: config.shadowProjects, phases, settings: new Map(records.map((record) => [record.key, record.value])) });
    // Every peer main's cluster routes accept, not only those sharing a folder now: the direct listener verifies the same
    // signatures, and a share the caller is not in gets the service's 403 (not retried) instead of a 401 (retried for good).
    const peers = peerSpecs(current.db, [...shares.flatMap((share) => share.peers), ...loaded.shares.verifiablePeers(current.db, current.nodeId)]);
    // Shares it reported or was given before; a drop is repeated until the project comes back, since the worker may have restarted meanwhile.
    const derived = new Set(shares.map((share) => share.key));
    const known = new Set([...current.shares.map((share) => share.key), ...current.desired?.dropShares ?? [], ...statuses.keys()]);
    const dropShares = loaded.shares.droppedShares(current.db, known).filter((key) => !derived.has(key));
    current.shares = shares;
    current.desired = {
      enabled: true, hostId: current.hostId, ...(current.signingKey ? { signingKey: current.signingKey } : {}),
      listen: { addresses: fileSyncListenAddresses(), port: config.port },
      shares, peers, records: { engines: listEngineRecords(current.db), settings: records }, ...(dropShares.length ? { dropShares } : {}),
    };
    // Only now: a failed derivation is retried by the next pass.
    current.revision = revision;
  });
  if (engine !== current) return;
  statuses.retain(new Set(current.shares.map((share) => share.key)));
  settled("fileSync:derive");
  void push(current);
}

/** Configure is the full desired state; one in flight at a time, and only when it changed. Resolves once what was desired at the call went out (or could not). */
function push(current: Engine): Promise<void> {
  return new Promise((resolve) => {
    current.pushWaiters.push(resolve);
    if (current.pushing) { current.pushAgain = true; return; }
    void runPush(current);
  });
}

async function runPush(current: Engine): Promise<void> {
  current.pushing = true;
  try {
    do {
      current.pushAgain = false;
      const desired = current.desired;
      if (!desired || engine !== current || current.bridge.state !== "running") return;
      // A KeyObject serializes as {}, so the key compares everything but the signing key, which never changes while running.
      const key = JSON.stringify(desired);
      if (key === current.sent) continue;
      const answer = await current.bridge.call("configure", desired);
      current.sent = key;
      if (Array.isArray(answer?.origins)) current.origins = answer.origins.filter((origin): origin is string => typeof origin === "string");
      settled("fileSync:configure");
    } while (current.pushAgain);
  } catch (error) {
    current.sent = undefined;
    warnOnChange("fileSync:configure", `File sync could not configure its worker: ${messageOf(error)}`);
  } finally {
    current.pushing = false;
    for (const resolve of current.pushWaiters.splice(0)) resolve();
  }
  if (current.announceWanted && current.sent !== undefined) void runAnnounce(current);
}

/** Coalesces bursts (a membership install rewrites several tables) into one derivation. */
function requestDerive(current: Engine | undefined = engine): void {
  if (!current || engine !== current || current.deriveTimer) return;
  current.deriveTimer = neutral(() => setTimeout(() => {
    current.deriveTimer = undefined;
    if (engine !== current) return;
    derive(current).catch((error) => warnOnChange("fileSync:derive", `File sync could not work out which folders to sync: ${messageOf(error)}`));
  }, DERIVE_COALESCE_MS));
  current.deriveTimer.unref();
}

function handleEvent(current: Engine, event: CoreEvent): void {
  if (engine !== current) return;
  // Logs, settles, metrics and relay requests are handled by the bridge.
  switch (event.event) {
    case "ready":
      if (Array.isArray(event.origins)) current.origins = event.origins.filter((origin): origin is string => typeof origin === "string");
      return;
    case "records":
      void receiveRecords(current, event);
      return;
    case "capability":
      // The worker learned it from the peer's signed /files/shares answer (or its 404: protocol 0).
      if (typeof event.peer !== "string" || !event.peer) return;
      notePeerFileSync(event.peer, {
        protocol: Number.isInteger(event.protocol) && event.protocol > 0 ? event.protocol : 0, via: "shares",
        ...(typeof event.enabled === "boolean" ? { enabled: event.enabled } : {}),
        // Only what main accepts reaches configure: a peer's answer must not point the worker at link-local or public addresses.
        origins: (Array.isArray(event.origins) ? event.origins : []).filter((origin) => typeof origin === "string" && acceptablePeerOrigin(origin)),
        ...(typeof event.hostId === "string" ? { hostId: event.hostId } : {}),
      });
      return;
    default:
      statuses.apply(event);
  }
}

/** Records come only from the peer whose signed answer carried them; records.ts decides which count. */
async function receiveRecords(current: Engine, event: Extract<CoreEvent, { event: "records" }>): Promise<void> {
  try {
    const loaded = await load();
    if (engine !== current) return;
    const outcome = loaded.records.acceptRecords(current.db, current.nodeId, { fromPeer: event.fromPeer, engines: event.engines ?? [], settings: event.settings ?? [] });
    settled("fileSync:records");
    // The triggers on the record tables would get there on the next 2 s pass; this does not wait for it.
    if (outcome.engines || outcome.settings) requestDerive(current);
  } catch (error) {
    warnOnChange("fileSync:records", `File sync could not store records from ${event.fromPeer}: ${messageOf(error)}`);
  }
}

/** The server's 2 s pass: one integer read unless the schema moved (a table rebuilt by a migration loses its triggers). */
export function fileSyncTick(): void {
  const current = engine;
  if (!current) return;
  try {
    const { revision, schema } = readRevision(current.db);
    let changed = revision !== current.revision;
    if (schema !== current.schema) {
      // Changes made while a trigger was missing went unseen.
      if (ensureRevisionTriggers(current.db) > 0) changed = true;
      current.schema = readRevision(current.db).schema;
    }
    if (changed) requestDerive(current);
    settled("fileSync:tick");
  } catch (error) {
    warnOnChange("fileSync:tick", `File sync could not check for sharing changes: ${messageOf(error)}`);
  }
}

/* Peers. Pulls happen on events only: this node starting or waking, a peer coming back or saying
   hello, a cluster join. Each asks the worker once; it decides which peers and shares need a pull. */

/** This node started, woke up or joined a cluster: the worker asks every capable peer what changed. A worker still starting does this after its first configure. */
export function fileSyncAnnounce(slept = false): void {
  const current = engine;
  if (!current) return;
  current.announceWanted = true;
  current.announceSlept ||= slept;
  if (current.bridge.state === "running" && current.sent !== undefined) void neutral(() => runAnnounce(current));
}

async function runAnnounce(current: Engine): Promise<void> {
  if (current.announcing) return;
  current.announcing = true;
  try {
    while (current.announceWanted && engine === current && current.bridge.state === "running" && current.sent !== undefined) {
      const slept = current.announceSlept;
      current.announceWanted = false;
      current.announceSlept = false;
      // Sharing may have changed (a join) and addresses too (a wake): the worker announces with what holds now.
      if (readRevision(current.db).revision !== current.revision || current.desired?.listen?.addresses.join(",") !== fileSyncListenAddresses().join(",")) await derive(current);
      await push(current);
      if (engine !== current || current.sent === undefined) break;
      await current.bridge.call("announce", { slept }).then(() => settled("fileSync:announce"), quietly("fileSync:announce", "File sync could not ask peers for changes"));
    }
  } catch (error) {
    warnOnChange("fileSync:announce", `File sync could not ask peers for changes: ${messageOf(error)}`);
  } finally {
    current.announcing = false;
  }
}

/** A peer is back (a relay saw it, it answered again, or it said hello): the worker flushes what it owes the peer and pulls what changed there. */
export function fileSyncPeerPresent(peer: string, returned = false): void {
  const current = engine;
  if (!current || current.bridge.state !== "running" || current.sent === undefined || peer === current.nodeId) return;
  const origins = peerOrigins(peer);
  const key = origins.join(",");
  const now = Date.now();
  const last = current.presence.get(peer);
  if (!returned && last && now - last.at < PRESENCE_COALESCE_MS && last.origins === key) return;
  current.presence.set(peer, { at: now, origins: key });
  neutral(() => current.bridge.call("peerPresence", { peer, present: true, origins }))
    .then(() => settled("fileSync:presence"), quietly("fileSync:presence", `File sync could not catch up with ${peer}`));
}

async function selfDescription(): Promise<HelloFileSync> {
  let enabled = false;
  try { enabled = readFileSyncConfig(await controlDatabase()).enabled; } catch { /* unknown counts as off */ }
  return helloFileSync({ origins: engine?.origins ?? [], enabled });
}

/** The fileSync part of this node's /hello body. Never throws. */
export async function fileSyncHelloBody(): Promise<{ fileSync: HelloFileSync }> {
  return { fileSync: await selfDescription() };
}

/** A peer said hello: note what it says about its engine, catch up with it, and answer with this node's part. Never throws. */
export async function fileSyncHelloReceived(peer: string, body: unknown): Promise<HelloFileSync> {
  try {
    notePeerFileSync(peer, { ...parseFileSyncPart(body), via: "hello" });
    fileSyncPeerPresent(peer);
  } catch (error) {
    warnOnChange("fileSync:hello", `File sync could not read ${peer}'s hello: ${messageOf(error)}`);
  }
  return selfDescription();
}

/** A peer answered this node's hello; an older one answers {ok: true} and so has no engine. Never throws. */
export function fileSyncHelloAnswered(peer: string, answer: unknown): void {
  try { notePeerFileSync(peer, { ...parseFileSyncPart(answer), via: "answer" }); }
  catch (error) { warnOnChange("fileSync:hello", `File sync could not read ${peer}'s hello answer: ${messageOf(error)}`); }
}

function flush(current: Engine, share: string, subtree?: string): void {
  // A share the worker has not reported is still waiting for its configure, which queues a full scan anyway.
  if (!statuses.get(share)) return;
  current.bridge.call("flush", subtree ? { share, subtree } : { share }, { timeoutMs: FLUSH_TIMEOUT_MS })
    .then(() => settled("fileSync:flush"), (error) => warnOnChange("fileSync:flush", `File sync could not pick up changed files: ${messageOf(error)}`));
}

/** A turn ended: what it wrote under its working directory goes out now, not after the watcher's debounce. */
export function fileSyncTurnEnded(cwd: string): void {
  const current = engine;
  if (!current || current.bridge.state !== "running" || !cwd) return;
  void load().then(({ shares }) => {
    if (engine !== current) return;
    const found = shares.shareContaining(current.shares, cwd);
    if (found) flush(current, found.share.key, found.subtree);
  }).catch((error) => warnOnChange("fileSync:flush", `File sync could not pick up changed files: ${messageOf(error)}`));
}

/** Someone opened the project: its shares are brought up to date, at most once per 30 s per project. */
export function fileSyncProjectOpened(projectId: string): void {
  const current = engine;
  if (!current || current.bridge.state !== "running") return;
  const now = Date.now();
  if (now - (projectOpenedAt.get(projectId) ?? -Infinity) < PROJECT_OPEN_INTERVAL_MS) return;
  projectOpenedAt.set(projectId, now);
  for (const share of current.shares) if (share.projectId === projectId) flush(current, share.key);
}

/* Status and the admin's actions (Settings → File sync). */

export interface FileSyncPeerStatus {
  nodeId: string;
  /** False while peer presence leaves the peer alone (it stopped answering). */
  present: boolean;
  /** null: not heard from since this node started; 0: the peer has no file sync engine. */
  protocol: number | null;
  enabled: boolean | null;
  origins: string[];
  /** How the worker last reached it for any share. */
  route: "direct" | "relay" | "none";
  heardAt: string | null;
}

export interface FileSyncStatusAnswer {
  enabled: boolean;
  worker: BridgeState | "starting" | "off";
  config: FileSyncConfig;
  /** Direct origins this node's worker listens on. */
  origins: string[];
  shares: ShareStatus[];
  peers: FileSyncPeerStatus[];
  /** /files/* requests since the worker started: sent by route, served directly and through main's routes. Absent while the worker does not answer. */
  requests?: { sent: RequestStats["sent"]; served: RequestStats["served"] & { relay: number } };
}

const STATS_TIMEOUT_MS = 2_000;

function peerStatuses(current: Engine, shares: readonly ShareStatus[]): FileSyncPeerStatus[] {
  const routes = new Map<string, "direct" | "relay" | "none">();
  for (const share of shares) for (const peer of share.peers ?? []) {
    const held = routes.get(peer.peer);
    if (peer.route === "direct" || !held || held === "none") routes.set(peer.peer, peer.route ?? "none");
  }
  // Peers that share a folder with this node; configure also lists the others, only so their signatures verify.
  const ids = new Set([...current.shares.flatMap((share) => share.peers), ...routes.keys()]);
  return [...ids].sort().map((nodeId) => {
    const known = peerFileSync(nodeId);
    return {
      nodeId, present: !peerAway(nodeId), protocol: known?.protocol ?? null, enabled: known?.enabled ?? null,
      origins: known?.origins ?? [], route: routes.get(nodeId) ?? "none", heardAt: known ? new Date(known.at).toISOString() : null,
    };
  });
}

export async function fileSyncStatus(): Promise<FileSyncStatusAnswer> {
  const config = readFileSyncConfig(await controlDatabase());
  const current = engine;
  const shares = current ? statuses.list(current.shares) : [];
  // The counters live in the worker's network layer; a busy or restarting worker leaves them out rather than holding up the page.
  const stats = current?.bridge.state === "running" ? await current.bridge.call("stats", {}, { timeoutMs: STATS_TIMEOUT_MS }).catch(() => undefined) : undefined;
  return {
    enabled: config.enabled, worker: current?.bridge.state ?? (starting ? "starting" : "off"), config,
    origins: current?.origins ?? [], shares, peers: current ? peerStatuses(current, shares) : [],
    ...(stats?.requests && current ? { requests: { sent: stats.requests.sent, served: { direct: stats.requests.served.direct, relay: current.bridge.served } } } : {}),
  };
}

/** A request the admin made that cannot be carried out; `status` is the HTTP answer. */
export class FileSyncRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export class FileSyncConfigError extends FileSyncRequestError {}

function runningEngine(): Engine {
  const current = engine;
  if (!current) throw new FileSyncRequestError(503, starting ? "File sync is starting on this node" : "File sync is off on this node");
  if (current.bridge.state !== "running") throw new FileSyncRequestError(503, current.bridge.state === "failed" ? "File sync stopped after repeated failures; save it as on again to retry" : "File sync is restarting on this node");
  return current;
}

function derivedShare(current: Engine, share: string, peer?: string): ShareSpec {
  try { parseShareKey(share); } catch { throw new FileSyncRequestError(400, "Invalid share"); }
  const spec = current.shares.find((candidate) => candidate.key === share);
  if (!spec) throw new FileSyncRequestError(404, "This node does not sync that folder");
  if (peer !== undefined && !spec.peers.includes(peer)) throw new FileSyncRequestError(404, "That machine does not sync this folder with this node");
  return spec;
}

/** The worker's error codes as HTTP answers: "invalid" 400, "unavailable" 503, a share it does not hold 404. */
async function adminCall<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === "invalid") throw new FileSyncRequestError(400, messageOf(error));
    if (code === "unavailable") throw new FileSyncRequestError(503, messageOf(error));
    if (/share not found/i.test(messageOf(error))) throw new FileSyncRequestError(404, "This node does not sync that folder");
    throw error;
  }
}

export async function fileSyncDifferences(share: string, peer: string, offset: number, limit: number): Promise<ListPage<DifferenceItem>> {
  const current = runningEngine();
  derivedShare(current, share, peer);
  return adminCall(() => current.bridge.call("differences", { share, peer, offset, limit }));
}

export async function fileSyncErrors(share: string, offset: number, limit: number): Promise<ListPage<ErrorItem>> {
  const current = runningEngine();
  derivedShare(current, share);
  return adminCall(() => current.bridge.call("errors", { share, offset, limit }));
}

/** Drops what this node stored about the peer's index for the share and pulls it again in full. */
export async function fileSyncRepair(share: string, peer: string): Promise<void> {
  const current = runningEngine();
  derivedShare(current, share, peer);
  await adminCall(() => current.bridge.call("repair", { share, peer }, { timeoutMs: FLUSH_TIMEOUT_MS }));
}

/** "Confirm deletions": the held deletes go ahead for paths still missing. */
export async function fileSyncReleaseHeld(share: string): Promise<ScanResult> {
  const current = runningEngine();
  derivedShare(current, share);
  return adminCall(() => current.bridge.call("releaseHeld", { share }, { timeoutMs: FLUSH_TIMEOUT_MS }));
}

/** The admin confirms that a folder which looks replaced is the one to sync. */
export async function fileSyncConfirmReplaced(share: string): Promise<ScanResult> {
  const current = runningEngine();
  derivedShare(current, share);
  return adminCall(() => current.bridge.call("confirmReplacedRoot", { share }, { timeoutMs: FLUSH_TIMEOUT_MS }));
}

/** Settings → File sync. Takes effect at once: enabling starts the worker (once startup has reached cluster work), disabling stops it. */
export async function applyFileSyncConfig(patch: FileSyncConfigPatch): Promise<FileSyncStatusAnswer> {
  const db = await controlDatabase();
  const held = readFileSyncConfig(db);
  // Saving the switch would change nothing while the environment overrides it; say so instead.
  if (patch.enabled !== undefined && held.enabledBy === "environment" && patch.enabled !== held.enabled) {
    throw new FileSyncConfigError(409, `JOINT_BOB_FILE_SYNC=${held.enabled ? 1 : 0} keeps file sync ${held.enabled ? "on" : "off"} on this node; change it in the service's environment`);
  }
  const wanted = Array.isArray(patch.shadowProjects) ? [...new Set(patch.shadowProjects)].sort() : patch.shadowProjects;
  if (wanted !== undefined && held.shadowProjectsBy === "environment" && JSON.stringify(wanted) !== JSON.stringify(held.shadowProjects)) {
    throw new FileSyncConfigError(409, "JOINT_BOB_FILE_SYNC_PROJECTS sets which projects file sync checks on this node; change it in the service's environment");
  }
  if (patch.enabled === false && holdsEngineProjects(db)) throw new FileSyncConfigError(409, "Move every project back to Syncthing before turning file sync off");
  const config = writeFileSyncConfig(db, patch);
  if (!config.enabled) await stopFileSync();
  else if (scope) {
    await neutral(ensureRunning);
    // Saving the switch again is how an admin retries a worker that kept crashing.
    if (engine?.bridge.state === "failed") neutral(() => engine?.bridge.start());
    if (engine && patch.shadowProjects !== undefined) await derive(engine);
  }
  return fileSyncStatus();
}
