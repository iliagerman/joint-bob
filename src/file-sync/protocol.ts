import type { KeyObject } from "node:crypto";
import { z } from "zod";
import type { EngineMode, EngineRecord, IndexEntry, Phase, SettingsRecord, ShareKind, ShareState } from "./types.js";

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
  /** Multi-user mode on Linux: apply never lowers a file's group bits (shared group access, §1 Permissions). */
  multiUser: z.boolean().optional(),
});
export type ConfigureArgs = z.infer<typeof configureSchema>;

export const scanScopeSchema = z.union([z.literal("full"), z.object({ paths: z.array(z.string()).max(100_000) })]);
export type ScanScope = z.infer<typeof scanScopeSchema>;

export interface ScanResult {
  share: string;
  /** Rows written (new versions, tombstones, merges). */
  changed: number;
  tombstones: number;
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
  /** Received from this peer for the share since the worker started (builtin transfers): bytes by route, files applied. */
  transfer?: { directBytes: number; relayBytes: number; files: number };
  /** cutover-engine (P5): the peer's announced builtin_since (null: not on built-in sync there, or not heard). */
  builtinSince?: number | null;
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
  scanning: boolean;
  watch: string;
  message?: string;
  peers: PeerShareStatus[];
  /** cutover-engine (P5): this node's maxSeq when its switch bootstrapped the share; null outside a switch. */
  builtinSince?: number | null;
  /** cutover-engine (P5): the project's engine as its owner recorded it (main fills it in; the phase above is this node's progress). */
  engine?: EngineMode;
  /** auto-transition: a full scan of the current generation finished (the first index is done). */
  indexed?: boolean;
}

export interface ListPage<T> { total: number; items: T[] }
/** Need rows under a prefix, blocked ones left out: `files` can arrive now; `waiting` only from `waiting.peers`, none of them available. */
export interface PendingFiles { files: number; bytes: number; waiting: { files: number; bytes: number; peers: string[] } }
export interface DifferenceItem { path: string; kind: "only-here" | "only-there" | "content" | "mode"; local?: Pick<IndexEntry, "size" | "mtimeMs" | "sha256" | "deleted">; remote?: Pick<IndexEntry, "size" | "mtimeMs" | "sha256" | "deleted">; since: string }
export interface ErrorItem { path: string; kind: "error" | "notice" | "blocked"; reason: string; at: string }

/** Where apply can take content without the network: a live local file (any share) or a trash file. */
export type LocalSource = { share: string; path: string } | { trash: string };
export type NeedItemAction = "fetch" | "delete" | "mkdir" | "symlink" | "meta" | "move";

/** One path this node should bring to `target` next (builtin phase, §5.4). */
export interface NeedItem {
  share: string;
  path: string;
  action: NeedItemAction;
  /** move: the local path (same share) renamed into place; its delete is applied with it. */
  fromPath?: string;
  target: IndexEntry;
  /** Eligible peers whose row has the target's content. */
  sources: string[];
  localSources: LocalSource[];
  conflict: boolean;
  priority: number;
  size: number;
  attempts: number;
}

/** What a transfer hands to apply for one path: a downloaded temp, a local copy to reuse, the row's move, or nothing (delete, folder, link, mode). */
export interface ApplyItemInput {
  path: string;
  /** Absolute path of the downloaded bytes: the deterministic temp beside the target. */
  tempPath?: string;
  /** Take the content from the need row's from_path (a rename). */
  move?: boolean;
  localSource?: LocalSource;
  /** The peer the bytes came from: it must still be in the share's peer set at the final rename (invariant 8). */
  source?: string;
  /** The temp as the transfer loop wrote it whole, every byte hash-checked as it streamed: apply skips hashing it again while it is still that file. */
  verified?: TempFingerprint;
}

export interface TempFingerprint { ino: number; size: number; mtimeMs: number; ctimeMs: number }

/** applied; stale (the target moved or the source left the share: the temp is gone, the path decided again); retry (later);
    changed (the path changed on disk under it: scanned now, retry soon); blocked (permanent until the cause changes). Apply
    records each in the need row (backoff, blocked) against the target it was about, and says so with `recorded`: a caller
    recording again could undo what the batch's own commit did (a block lifted by the folder it just made). */
export type ApplyOutcome = "applied" | "stale" | "retry" | "changed" | "blocked";
export interface ApplyItemResult { path: string; outcome: ApplyOutcome; reason?: string; /** blocked by disk space: offered again after this */ retryAfterMs?: number }
export interface ApplyBatchResult { applied: number; items: ApplyItemResult[]; recorded: true }

const localSourceSchema = z.union([z.object({ share: z.string(), path: z.string() }), z.object({ trash: z.string() })]);
const fingerprintSchema = z.object({ ino: z.number(), size: z.number().int().min(0), mtimeMs: z.number(), ctimeMs: z.number() });
const applyItemSchema = z.object({
  path: z.string(), tempPath: z.string().optional(), move: z.boolean().optional(), localSource: localSourceSchema.optional(), source: z.string().optional(),
  verified: fingerprintSchema.optional(),
});

/** Endpoints a peer can call; served by the worker's direct listener and, through `serve`, by main's routes. */
export type FilesEndpoint = "shares" | "index" | "changed" | "fetch" | "file" | "status";

export const opSchemas = {
  configure: configureSchema,
  scan: z.object({ share: z.string(), scope: scanScopeSchema, reason: z.string() }),
  flush: z.object({ share: z.string(), subtree: z.string().optional() }),
  prioritize: z.object({ share: z.string(), prefix: z.string().optional(), untilMs: z.number() }),
  peerPresence: z.object({ peer: z.string(), present: z.boolean(), origins: z.array(z.string()).optional() }),
  announce: z.object({ slept: z.boolean() }),
  notice: z.object({ peer: z.string(), body: z.unknown() }),
  serve: z.object({ peer: z.string(), endpoint: z.enum(["shares", "index", "changed", "fetch", "file", "status"]), query: z.record(z.string()).default({}), body: z.unknown().optional(), range: z.string().optional() }),
  status: z.object({ shares: z.array(z.string()).optional() }),
  differences: z.object({ share: z.string(), peer: z.string(), offset: z.number().int().min(0), limit: z.number().int().positive().max(200) }),
  errors: z.object({ share: z.string(), offset: z.number().int().min(0), limit: z.number().int().positive().max(200) }),
  confirmReplacedRoot: z.object({ share: z.string() }),
  bootstrap: z.object({ share: z.string(), builtinSinceByPeer: z.record(z.number().int()) }),
  /** The transfer queue: what to fetch, move or apply next (§5.4, §6.2). `inFlight` items are left out. */
  nextNeeds: z.object({
    limit: z.number().int().min(0).max(10_000),
    availablePeers: z.array(z.string()).optional(),
    inFlight: z.array(z.union([z.string(), z.object({ share: z.string(), path: z.string() })])).optional(),
    shares: z.array(z.string()).optional(),
  }),
  /** Writes what a transfer brought (or a move, a local copy) into the tree (§5.5); builtin phase only. */
  applyBatch: z.object({ share: z.string(), items: z.array(applyItemSchema).max(1000) }),
  repair: z.object({ share: z.string(), peer: z.string() }),
  /** fix (P4+P5): need rows under `prefix` (a worktree): what can arrive now from `availablePeers` or a local copy, and what only an unavailable peer has. */
  pending: z.object({ share: z.string(), prefix: z.string(), availablePeers: z.array(z.string()) }),
  /** Answered by the worker's adapter (its network layer), not the core. */
  stats: z.object({}),
  /** Main's event loop is busy (ELU > 70 % for 10 s) or calm again: new relay-fallback transfers wait meanwhile (§6.2). */
  pace: z.object({ relayPaused: z.boolean() }),
  stop: z.object({}),
} as const;

/** /files/* requests since the worker started: sent by the route that carried them, served by the direct listener. */
export interface RequestStats { sent: { direct: number; relay: number; failed: number }; served: { direct: number } }

export interface ServeAnswer { status: number; headers: Record<string, string>; /** JSON answers */ json?: unknown; /** binary answers stream as chunk events on a MessagePort in the thread adapter, or as an iterable in-thread */ body?: AsyncIterable<Uint8Array> }

export interface OpResults {
  configure: { origins: string[] };
  scan: ScanResult;
  flush: ScanResult;
  prioritize: Record<string, never>;
  peerPresence: Record<string, never>;
  announce: Record<string, never>;
  notice: Record<string, never>;
  serve: ServeAnswer;
  status: ShareStatus[];
  differences: ListPage<DifferenceItem>;
  errors: ListPage<ErrorItem>;
  confirmReplacedRoot: ScanResult;
  bootstrap: { merged: number; need: number };
  nextNeeds: { items: NeedItem[]; nextRetryAt?: number };
  applyBatch: ApplyBatchResult;
  repair: Record<string, never>;
  pending: PendingFiles;
  stats: { requests: RequestStats };
  pace: Record<string, never>;
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
  /** A peer's settled difference count or clean-since moved (shadow mode, §5.4); shareState carries the same numbers. */
  | { event: "diffChanged"; share: string; peer: string; differences: number; cleanSince: string | null }
  | { event: "metric"; operation: string; durationMs: number; fields?: Record<string, number | string | boolean> }
  | { event: "relayRequest"; id: number; peer: string; request: RelayedRequest };

/* Byte streams between the threads. Main answers a relayRequest with RelayMessages; a streamed serve
   answer (ServeHead.stream) follows its `{id, ok, result}` as ServeMessages under the same id. Bytes
   travel as transferred ArrayBuffers; the receiver acknowledges what its reader took, and the sender
   waits while more than STREAM_WINDOW_BYTES are unacknowledged. */

/** A request the worker asks main to send for it: the peer's direct origins failed or are unknown. */
export interface RelayedRequest {
  method: "GET" | "POST";
  /** Path and query under /api/cluster/v2/files/, exactly as it is signed. */
  target: string;
  json?: unknown;
  headers?: Record<string, string>;
  purpose?: "notice" | "index" | "transfer" | "status" | "shares";
  /** Someone is waiting for it: sent even to a peer that looks away (outside whilePeerOptional). */
  foreground?: boolean;
}

export const STREAM_WINDOW_BYTES = 4 * 1024 * 1024;

/** Main → worker, for one relayRequest id: the answer's head, its body, then its end or failure. */
export type RelayMessage =
  | { relayResponse: number; status: number; headers: Record<string, string> }
  | { relayChunk: number; chunk: ArrayBuffer }
  | { relayEnd: number }
  /** `away`: main has the peer as away now; it reports the return (peerPresence), so nothing need be retried before. */
  | { relayError: number; message: string; code?: string; away?: boolean };

/** Worker → main: bytes of a relay answer its reader took, or the reader gave up. */
export type RelayControl = { relayAck: number; bytes: number } | { relayCancel: number };

/** The serve op's result as it crosses the threads: a JSON answer whole, a byte answer as ServeMessages after it. */
export interface ServeHead { status: number; headers: Record<string, string>; json?: unknown; stream: boolean }

/** Worker → main, for one serve request id: the body of a streamed answer. */
export type ServeMessage = { serveChunk: number; chunk: ArrayBuffer } | { serveEnd: number } | { serveError: number; message: string };

/** Main → worker: serve bytes main took, or its HTTP client went away. */
export type ServeControl = { serveAck: number; bytes: number } | { serveCancel: number };

/** Version of the wire protocol between engines. Additive changes keep it; a required new behavior bumps it. */
export const FILE_SYNC_PROTOCOL = 2;
/** Older engines still compare in shadow mode: protocol 1 (2.157, 2.158) has the engine but not the switch. */
export const FILE_SYNC_MIN_PROTOCOL = 1;
/** cutover-engine (P5): a peer below this never leaves Syncthing for a switched project, so a project it shares stays on Syncthing (or moves back). */
export const FILE_SYNC_SWITCH_PROTOCOL = 2;
