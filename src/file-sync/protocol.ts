import type { KeyObject } from "node:crypto";
import { z } from "zod";
import type { EngineRecord, IndexEntry, Phase, SettingsRecord, ShareKind, ShareState } from "./types.js";

/* Messages between the main thread (control plane) and the worker core (data plane). The worker is the
   only writer of file-sync.db; main owns everything durable (node.db) and pushes the desired state with
   `configure`. Every op and event is defined here first so both halves are built against one contract. */

const shareKind = z.enum(["project", "tickets", "worktrees"]);
const phase = z.enum(["syncthing", "releasing", "bootstrapping", "builtin", "restoring"]);
const ruleSettings = z.object({
  disabledBuiltins: z.array(z.string()).default([]),
  userRules: z.array(z.string()).default([]),
  removedUserRules: z.array(z.string()).default([]),
  gitignore: z.boolean().default(false),
  importedFrom: z.array(z.string()).default([]),
});

export const shareSpecSchema = z.object({
  key: z.string(),
  projectId: z.string(),
  kind: shareKind,
  root: z.string(),
  /** Writes into the tree happen only in "builtin"; every other phase is shadow. */
  phase,
  /** Effective rules: the project's record over its owner's global record. */
  rules: ruleSettings,
  /** Peers allowed to sync this share right now (authorization snapshot). */
  peers: z.array(z.string()),
});
export type ShareSpec = z.infer<typeof shareSpecSchema> & { kind: ShareKind; phase: Phase };

export const peerSpecSchema = z.object({
  nodeId: z.string(),
  /** Pinned Ed25519 public key (PEM) that signs this peer's requests. */
  publicKey: z.string(),
  /** Direct origins the peer advertised (http://<tailnet ip>:<port>). */
  origins: z.array(z.string()).default([]),
  /** False while the peer is away (peer-presence); the core sends it nothing in the background. */
  present: z.boolean(),
});
export type PeerSpec = z.infer<typeof peerSpecSchema>;

const engineRecord = z.object({ projectId: z.string(), mode: z.enum(["syncthing", "builtin"]), generation: z.number().int(), updatedAt: z.string(), origin: z.string() });
const settingsRecord = z.object({ key: z.string(), value: ruleSettings, updatedAt: z.string(), origin: z.string() });

export const configureSchema = z.object({
  enabled: z.boolean(),
  /** This node's cluster signing key (KeyObjects cross threads by postMessage). */
  signingKey: z.custom<KeyObject>((value) => value !== null && typeof value === "object").optional(),
  listen: z.object({ addresses: z.array(z.string()), port: z.number().int().positive() }).optional(),
  hostId: z.string(),
  shares: z.array(shareSpecSchema),
  peers: z.array(peerSpecSchema),
  /** Records this node serves to peers in /files/shares answers. */
  records: z.object({ engines: z.array(engineRecord), settings: z.array(settingsRecord) }),
  /** Shares whose index state goes for good (project removed, policy deleted, §4). A share merely absent from `shares` keeps its rows. */
  dropShares: z.array(z.string()).optional(),
});
export type ConfigureArgs = z.infer<typeof configureSchema>;

export const scanScopeSchema = z.union([z.literal("full"), z.object({ paths: z.array(z.string()).max(100_000) })]);
export type ScanScope = z.infer<typeof scanScopeSchema>;

export interface ScanResult {
  share: string;
  /** Rows written (new versions, tombstones, merges). */
  changed: number;
  tombstones: number;
  held: number;
  /** The root identity changed or the share was new: nothing was deleted. */
  newGeneration: boolean;
  files: number;
  hashedBytes: number;
  durationMs: number;
  error?: string;
}

export interface PeerShareStatus {
  peer: string;
  /** Highest seq of the peer's index this node has stored (the paging contract makes it reach peerMaxSeq). */
  cursor: number;
  peerMaxSeq: number;
  peerIndexId: string | null;
  peerDigest: string | null;
  rulesMatch: boolean;
  /** Our cursor has reached the peer's announced maxSeq under the same index id. */
  caughtUp: boolean;
  /** Paths whose content differs from this peer's announced index (settled, both sides synced). */
  differences: number;
  cleanSince: string | null;
  route: "direct" | "relay" | "none";
}

export interface ShareStatus {
  share: string;
  projectId: string;
  kind: ShareKind;
  state: ShareState;
  phase: Phase;
  maxSeq: number;
  indexId: string;
  digest: string;
  rulesHash: string;
  liveFiles: number;
  liveBytes: number;
  need: { files: number; bytes: number };
  blocked: number;
  errors: number;
  held: number;
  scanning: boolean;
  watch: string;
  message?: string;
  peers: PeerShareStatus[];
}

export interface ListPage<T> { total: number; items: T[] }
export interface DifferenceItem { path: string; kind: "only-here" | "only-there" | "content" | "mode"; local?: Pick<IndexEntry, "size" | "mtimeMs" | "sha256" | "deleted">; remote?: Pick<IndexEntry, "size" | "mtimeMs" | "sha256" | "deleted">; since: string }
export interface ErrorItem { path: string; kind: "error" | "notice" | "blocked"; reason: string; at: string }

/** Endpoints a peer can call; served by the worker's direct listener and, through `serve`, by main's routes. */
export type FilesEndpoint = "shares" | "index" | "changed" | "fetch" | "file" | "status";

export const opSchemas = {
  configure: configureSchema,
  scan: z.object({ share: z.string(), scope: scanScopeSchema, reason: z.string() }),
  flush: z.object({ share: z.string(), subtree: z.string().optional() }),
  prioritize: z.object({ share: z.string(), prefix: z.string().optional(), untilMs: z.number() }),
  expectDeletes: z.object({ share: z.string(), prefix: z.string(), ttlMs: z.number().int().positive() }),
  peerPresence: z.object({ peer: z.string(), present: z.boolean(), origins: z.array(z.string()).optional() }),
  announce: z.object({ slept: z.boolean() }),
  notice: z.object({ peer: z.string(), body: z.unknown() }),
  serve: z.object({ peer: z.string(), endpoint: z.enum(["shares", "index", "changed", "fetch", "file", "status"]), query: z.record(z.string()).default({}), body: z.unknown().optional(), range: z.string().optional() }),
  status: z.object({ shares: z.array(z.string()).optional() }),
  differences: z.object({ share: z.string(), peer: z.string(), offset: z.number().int().min(0), limit: z.number().int().positive().max(200) }),
  errors: z.object({ share: z.string(), offset: z.number().int().min(0), limit: z.number().int().positive().max(200) }),
  releaseHeld: z.object({ share: z.string() }),
  confirmReplacedRoot: z.object({ share: z.string() }),
  bootstrap: z.object({ share: z.string(), builtinSinceByPeer: z.record(z.number().int()) }),
  repair: z.object({ share: z.string(), peer: z.string() }),
  stop: z.object({}),
} as const;

export interface ServeAnswer { status: number; headers: Record<string, string>; /** JSON answers */ json?: unknown; /** binary answers stream as chunk events on a MessagePort in the thread adapter, or as an iterable in-thread */ body?: AsyncIterable<Uint8Array> }

export interface OpResults {
  configure: { origins: string[] };
  scan: ScanResult;
  flush: ScanResult;
  prioritize: Record<string, never>;
  expectDeletes: Record<string, never>;
  peerPresence: Record<string, never>;
  announce: Record<string, never>;
  notice: Record<string, never>;
  serve: ServeAnswer;
  status: ShareStatus[];
  differences: ListPage<DifferenceItem>;
  errors: ListPage<ErrorItem>;
  releaseHeld: ScanResult;
  confirmReplacedRoot: ScanResult;
  bootstrap: { merged: number; need: number };
  repair: Record<string, never>;
  stop: Record<string, never>;
}

export type OpName = keyof typeof opSchemas;
export type OpArgs = { [K in OpName]: z.input<(typeof opSchemas)[K]> };

export type CoreEvent =
  | { event: "ready"; origins: string[] }
  | { event: "shareState"; status: ShareStatus }
  | { event: "shareRemoved"; share: string }
  | { event: "records"; fromPeer: string; engines: EngineRecord[]; settings: SettingsRecord[] }
  | { event: "capability"; peer: string; protocol: number; enabled: boolean; origins: string[]; hostId?: string }
  | { event: "log"; level: "info" | "warn" | "error"; key: string; message: string }
  | { event: "settled"; key: string }
  | { event: "metric"; operation: string; durationMs: number; fields?: Record<string, number | string | boolean> }
  | { event: "relayRequest"; id: number; peer: string; request: { method: "GET" | "POST"; target: string; json?: unknown; headers?: Record<string, string> } };

/** Version of the wire protocol between engines. Additive changes keep it; a required new behavior bumps it. */
export const FILE_SYNC_PROTOCOL = 1;
export const FILE_SYNC_MIN_PROTOCOL = 1;
