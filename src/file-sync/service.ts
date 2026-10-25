import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { ZodError } from "zod";
import type { FileSyncDb } from "./db.js";
import { FILE_SYNC_MIN_PROTOCOL, FILE_SYNC_PROTOCOL, type ConfigureArgs, type FilesEndpoint, type ServeAnswer, type ShareSpec } from "./protocol.js";
import { shareKey, type Clock, type ShareKind, type ShareState } from "./types.js";
import {
  changedBodySchema, indexIdSchema, indexQuerySchema, INDEX_CONTENT_TYPE, NOT_SHARED_ERROR, statusBodySchema, toWire,
  type SharesAnswer, type StatusAnswer,
} from "./wire.js";

/* Server logic of /api/cluster/v2/files/* (FILE-SYNC design §6.3), transport-agnostic: the direct
   listener and main's relay-fallback routes both call serve() once the request's signature is
   verified. Authorization per share is here: the caller must be in the share's peer set of the last
   configure, whatever else it may be allowed. Index pages are built and compressed here, in the
   worker, so neither the bytes nor the rows pass through the main thread. */

export interface FilesService {
  serve(peer: string, endpoint: FilesEndpoint, query: Record<string, string>, body: unknown, range?: string): Promise<ServeAnswer>;
}

export interface ServedShare {
  spec: ShareSpec;
  rulesHash: string;
  state(): ShareState;
}

/** A share a peer named, as `changed` and `status` hand it to the sync layer. */
export interface Announced { key: string; indexId: string; maxSeq: number; rulesHash?: string }

export interface ServiceDeps {
  db: FileSyncDb;
  nodeId: string;
  clock: Clock;
  config(): ConfigureArgs | undefined;
  origins(): string[];
  shares(): ReadonlyMap<string, ServedShare>;
  /** An authorized `changed` notice: compare and pull. `records` asks for the sender's shares answer. */
  changed(peer: string, shares: Announced[], records: boolean): void;
  /** An authorized `status` request: a caller ahead of our cursor is pulled from at once. */
  status(peer: string, shares: Announced[]): void;
  /** Tests: runs between reading an index page and reading the maxSeq it is paired with. */
  hooks?: { indexSnapshot?(): void };
}

class ServiceError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const notShared = (): ServiceError => new ServiceError(403, NOT_SHARED_ERROR);
const gzipAsync = promisify(gzip);
const yieldTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
/** Entries encoded per turn of the event loop. */
const SERIALIZE_CHUNK = 500;

function json(status: number, value: unknown): ServeAnswer {
  return { status, headers: { "content-type": "application/json; charset=utf-8" }, json: value };
}

async function* once(bytes: Uint8Array): AsyncIterable<Uint8Array> { yield bytes; }

export function createFilesService(deps: ServiceDeps): FilesService {
  const { db } = deps;

  function servedFor(peer: string): ServedShare[] {
    return [...deps.shares().values()].filter((share) => share.spec.peers.includes(peer));
  }

  /** A share missing from the last configure is refused like one the caller is not in: main derives again on its own triggers. */
  function authorized(peer: string, projectId: string, kind: ShareKind): ServedShare {
    const served = deps.shares().get(shareKey({ projectId, kind }));
    if (!served || !served.spec.peers.includes(peer)) throw notShared();
    return served;
  }

  function shares(peer: string): ServeAnswer {
    const config = deps.config();
    const served = config?.enabled ? servedFor(peer) : [];
    const projects = new Set(served.map((share) => share.spec.projectId));
    const answer: SharesAnswer = {
      fileSync: { protocol: FILE_SYNC_PROTOCOL, minProtocol: FILE_SYNC_MIN_PROTOCOL, enabled: Boolean(config?.enabled) },
      nodeId: deps.nodeId,
      hostId: config?.hostId ?? "",
      origins: deps.origins(),
      shares: served.flatMap((share) => {
        const row = db.share(share.spec.key);
        if (!row) return [];
        return [{
          projectId: share.spec.projectId, kind: share.spec.kind, indexId: row.indexId, maxSeq: row.maxSeq, digest: row.digest, rulesHash: share.rulesHash,
          state: share.state(), builtinSince: row.builtinSince, prunedBelow: row.prunedBelow, rootDev: row.rootDev, rootIno: row.rootIno,
        }];
      }),
      // Records about projects the caller shares, and this node's own all-projects rules once it shares anything.
      engines: (config?.records.engines ?? []).filter((record) => projects.has(record.projectId)),
      settings: (config?.records.settings ?? []).filter((record) => record.key.startsWith("project:")
        ? projects.has(record.key.slice("project:".length))
        : record.key === `global:${deps.nodeId}` && projects.size > 0),
    };
    return json(200, answer);
  }

  async function index(peer: string, query: Record<string, string>): Promise<ServeAnswer> {
    const parsed = indexQuerySchema.parse(query);
    // Not in indexQuerySchema (old wire module): the generation the caller's `since` belongs to.
    const known = query.indexId !== undefined ? indexIdSchema.safeParse(query.indexId) : undefined;
    const served = authorized(peer, parsed.projectId, parsed.kind);
    const key = served.spec.key;
    // One snapshot: rows and the maxSeq they are paired with, so `more ? last.seq : maxSeq` can never skip a row committed in between.
    const { rows, share } = db.readTx(() => {
      const rows = db.entriesSince(key, parsed.since, parsed.limit + 1);
      deps.hooks?.indexSnapshot?.();
      return { rows, share: db.share(key) };
    });
    if (!share) throw notShared();
    const more = rows.length > parsed.limit;
    const entries = more ? rows.slice(0, parsed.limit) : rows;
    const head = JSON.stringify({
      indexId: share.indexId, maxSeq: share.maxSeq, digest: share.digest, prunedBelow: share.prunedBelow, builtinSince: share.builtinSince,
      rulesHash: served.rulesHash, more,
    });
    // The rows are one snapshot already; encoding them goes in slices and compression on zlib's pool, so a
    // 5,000-entry page does not hold up the worker's other requests and scans (§5.1).
    const parts: string[] = [];
    for (let at = 0; at < entries.length; at += SERIALIZE_CHUNK) {
      if (at) await yieldTurn();
      parts.push(entries.slice(at, at + SERIALIZE_CHUNK).map((entry) => JSON.stringify(toWire(entry))).join(","));
    }
    const bytes = await gzipAsync(Buffer.from(`${head.slice(0, -1)},"entries":[${parts.join(",")}]}`, "utf8"));
    // The caller holds everything up to `since` of this generation: tombstones it acknowledged may be pruned (§5.2.8).
    // A `since` from another generation (or from a caller that does not say which) acknowledges nothing.
    if (parsed.since <= share.maxSeq && (parsed.since === 0 || (known?.success && known.data === share.indexId))) {
      db.writeTx(() => db.setAck(key, peer, share.indexId, parsed.since, deps.clock.now()));
    }
    // Compressed JSON as the body's own type: no Content-Encoding (main's cluster routes refuse encoded bodies, proxies may undo them).
    return { status: 200, headers: { "content-type": INDEX_CONTENT_TYPE, "content-length": String(bytes.length) }, body: once(bytes) };
  }

  function changed(peer: string, body: unknown): ServeAnswer {
    const parsed = changedBodySchema.parse(body ?? {});
    const served = deps.shares();
    const named: Announced[] = [];
    for (const share of parsed.shares) {
      const key = shareKey(share);
      if (served.get(key)?.spec.peers.includes(peer)) named.push({ key, indexId: share.indexId, maxSeq: share.maxSeq, ...(share.rulesHash ? { rulesHash: share.rulesHash } : {}) });
    }
    if (!named.length && (parsed.shares.length || !servedFor(peer).length)) throw notShared();
    // Scheduling only: the pulls run after the answer.
    deps.changed(peer, named, Boolean(parsed.records));
    return json(202, {});
  }

  function status(peer: string, body: unknown): ServeAnswer {
    const parsed = statusBodySchema.parse(body ?? {});
    const served = servedFor(peer).filter((share) => share.spec.projectId === parsed.projectId);
    if (!served.length) throw notShared();
    const answer: StatusAnswer = {
      shares: served.flatMap((share) => {
        const row = db.share(share.spec.key);
        if (!row) return [];
        const cursor = db.cursor(share.spec.key, peer);
        const need = db.needSummary(share.spec.key);
        return [{
          kind: share.spec.kind, state: share.state(), cursor: cursor?.indexId ? cursor.seq : 0, callerIndexId: cursor?.indexId ?? null,
          need: { files: need.files, bytes: need.bytes }, blocked: need.blocked, errors: db.errorCount(share.spec.key), digest: row.digest, maxSeq: row.maxSeq,
        }];
      }),
    };
    const asked: Announced[] = [];
    for (const share of parsed.shares ?? []) {
      const key = shareKey({ projectId: parsed.projectId, kind: share.kind });
      if (served.some((candidate) => candidate.spec.key === key)) asked.push({ key, indexId: share.indexId, maxSeq: share.maxSeq });
    }
    if (asked.length) deps.status(peer, asked);
    return json(200, answer);
  }

  return {
    async serve(peer, endpoint, query, body) {
      // Before the first configure nothing is authorized yet; a caller retries with backoff.
      if (!deps.config()) return json(503, { error: "File sync is starting" });
      try {
        switch (endpoint) {
          case "shares": return shares(peer);
          case "index": return await index(peer, query ?? {});
          case "changed": return changed(peer, body);
          case "status": return status(peer, body);
          case "fetch":
          case "file": return json(501, { error: "Not available in this phase" });
          default: return json(404, { error: "Not found" });
        }
      } catch (error) {
        if (error instanceof ServiceError) return json(error.status, { error: error.message });
        if (error instanceof ZodError) return json(400, { error: "Invalid request" });
        throw error;
      }
    },
  };
}
