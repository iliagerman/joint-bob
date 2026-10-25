import { AsyncResource } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { onRelayPeersChanged } from "../relay/events.js";
import { settled, warnOnChange } from "../server/quiet-log.js";
import type { BridgeState, WorkerBridge } from "./bridge.js";
import { controlDatabase, ensureRevisionTriggers, holdsEngineProjects, listEngineRecords, listPhases, listSettingsRecords, readFileSyncConfig, readRevision, writeFileSyncConfig, type FileSyncConfig, type FileSyncConfigPatch } from "./control.js";
import type { ConfigureArgs, CoreEvent, ShareSpec, ShareStatus } from "./protocol.js";
import { ShareStatusStore } from "./status.js";

/* Starts and stops the file sync worker and keeps it configured with the shares derived from
   node.db. Callers (server.ts, turn ends, project opens, Settings) never get an exception from
   here: failures are logged once per reason. Nothing loads the engine's heavier modules until it
   actually runs, so the hooks cost nothing on a node with file sync off. */

const STOP_BUDGET_MS = 2_000;
const FLUSH_TIMEOUT_MS = 60_000;
const PROJECT_OPEN_INTERVAL_MS = 30_000;
const DERIVE_COALESCE_MS = 250;

interface Modules {
  bridge: typeof import("./bridge.js");
  shares: typeof import("./shares.js");
  peers: typeof import("./peers.js");
  cluster: typeof import("../cluster.js");
  performance: typeof import("../server/performance-diagnostics.js");
}

interface Engine {
  db: DatabaseSync;
  nodeId: string;
  hostId: string;
  bridge: WorkerBridge;
  shares: ShareSpec[];
  desired?: ConfigureArgs;
  sent?: string;
  pushing: boolean;
  pushAgain: boolean;
  revision: number;
  schema: number;
  deriveTimer?: NodeJS.Timeout;
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

function load(): Promise<Modules> {
  modules ??= Promise.all([import("./bridge.js"), import("./shares.js"), import("./peers.js"), import("../cluster.js"), import("../server/performance-diagnostics.js")])
    .then(([bridge, shares, peers, cluster, performance]) => ({ bridge, shares, peers, cluster, performance }));
  return modules;
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Work started from a request or a background pass runs in startup's context, so the worker's events and timers inherit neither. */
function neutral<T>(work: () => T): T { return scope ? scope.runInAsyncScope(work) : work(); }

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
  const current: Engine = { db, nodeId, hostId: loaded.shares.fileSyncHostId(), bridge: undefined as unknown as WorkerBridge, shares: [], pushing: false, pushAgain: false, revision: -1, schema: readRevision(db).schema, unsubscribe: [] };
  current.bridge = new loaded.bridge.WorkerBridge({
    nodeId,
    // A new worker knows nothing: it gets the whole desired state again.
    onStart: () => { current.sent = undefined; void push(current); },
    onEvent: (event) => handleEvent(current, event),
  });
  engine = current;
  // The worker starts even so: its revision stays unknown, so the next 2 s pass derives again.
  await derive(current).catch((error) => warnOnChange("fileSync:derive", `File sync could not work out which folders to sync: ${messageOf(error)}`));
  if (engine !== current) return;
  current.unsubscribe.push(
    onRelayPeersChanged(() => requestDerive(current)),
    loaded.peers.onPeerPresent(() => requestDerive(current)),
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
    const peers = loaded.peers.peerSpecs(current.db, shares.flatMap((share) => share.peers));
    // Shares it reported or was given before; a drop is repeated until the project comes back, since the worker may have restarted meanwhile.
    const derived = new Set(shares.map((share) => share.key));
    const known = new Set([...current.shares.map((share) => share.key), ...current.desired?.dropShares ?? [], ...statuses.keys()]);
    const dropShares = loaded.shares.droppedShares(current.db, known).filter((key) => !derived.has(key));
    current.shares = shares;
    current.desired = { enabled: true, hostId: current.hostId, shares, peers, records: { engines: listEngineRecords(current.db), settings: records }, ...(dropShares.length ? { dropShares } : {}) };
    // Only now: a failed derivation is retried by the next pass.
    current.revision = revision;
  });
  if (engine !== current) return;
  statuses.retain(new Set(current.shares.map((share) => share.key)));
  settled("fileSync:derive");
  void push(current);
}

/** Configure is the full desired state; one in flight at a time, and only when it changed. */
async function push(current: Engine): Promise<void> {
  if (current.pushing) { current.pushAgain = true; return; }
  current.pushing = true;
  try {
    do {
      current.pushAgain = false;
      const desired = current.desired;
      if (!desired || engine !== current || current.bridge.state !== "running") return;
      const key = JSON.stringify(desired);
      if (key === current.sent) continue;
      await current.bridge.call("configure", desired);
      current.sent = key;
      settled("fileSync:configure");
    } while (current.pushAgain);
  } catch (error) {
    current.sent = undefined;
    warnOnChange("fileSync:configure", `File sync could not configure its worker: ${messageOf(error)}`);
  } finally {
    current.pushing = false;
  }
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
  // Logs, settles and metrics are handled by the bridge; records, capability and relay requests
  // belong to the network phases, and no P1 worker sends them.
  statuses.apply(event);
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

export interface FileSyncStatusAnswer {
  enabled: boolean;
  worker: BridgeState | "starting" | "off";
  config: FileSyncConfig;
  shares: ShareStatus[];
}

export async function fileSyncStatus(): Promise<FileSyncStatusAnswer> {
  const config = readFileSyncConfig(await controlDatabase());
  const current = engine;
  return { enabled: config.enabled, worker: current?.bridge.state ?? (starting ? "starting" : "off"), config, shares: current ? statuses.list(current.shares) : [] };
}

export class FileSyncConfigError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Settings → File sync. Takes effect at once: enabling starts the worker (once startup has reached cluster work), disabling stops it. */
export async function applyFileSyncConfig(patch: FileSyncConfigPatch): Promise<FileSyncStatusAnswer> {
  const db = await controlDatabase();
  const held = readFileSyncConfig(db);
  // Saving the switch would change nothing while the environment overrides it; say so instead.
  if (patch.enabled !== undefined && held.enabledBy === "environment" && patch.enabled !== held.enabled) {
    throw new FileSyncConfigError(409, `JOINT_BOB_FILE_SYNC=${held.enabled ? 1 : 0} keeps file sync ${held.enabled ? "on" : "off"} on this node; change it in the service's environment`);
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
