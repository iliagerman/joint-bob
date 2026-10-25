import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { z } from "zod";
import { normalizeRelativePath, PathError } from "./paths.js";
import type { FilesEndpoint } from "./protocol.js";
import { FILE, SYMLINK, type IndexEntry, type Vector } from "./types.js";

/* What engines send each other. Objects strip unknown keys (a newer peer may add fields within a
   protocol version) but every known value is checked strictly, and an index page with one bad entry
   is rejected whole: a partly stored page would move the cursor past rows we never saw. */

export const FILES_API = "/api/cluster/v2/files";
export const INDEX_CONTENT_TYPE = "application/x-joint-bob-index+gzip";
export const INDEX_PAGE_LIMIT = 5000;
/** Uncompressed ceiling for one index page (5,000 entries are ~2 MB); guards gunzip. */
export const INDEX_PAGE_MAX_BYTES = 64 * 1024 * 1024;
export const FETCH_ITEM_LIMIT = 256;
export const NOT_SHARED_ERROR = "Project is not shared with this node";

export class WireError extends Error {}

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const safeInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
// Node ids are cluster UUIDs; the first character rule also keeps "__proto__" out of vector keys.
export const nodeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const projectIdSchema = z.string().min(1).max(240);
export const shareKindSchema = z.enum(["project", "tickets", "worktrees"]);
export const indexIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const shareStateSchema = z.enum(["starting", "scanning", "idle", "error", "unavailable"]);
export const vectorSchema = z.record(nodeIdSchema, z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
  .refine((vector) => { const size = Object.keys(vector).length; return size > 0 && size <= 1000; }, "Version must name 1 to 1000 nodes");
/** A share-relative path, returned as its NFC index key. */
export const relativePathSchema = z.string().max(16_384).transform((value, context) => {
  try { return normalizeRelativePath(value); } catch (error) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof PathError ? error.message : "Invalid path" });
    return z.NEVER;
  }
});
/** A direct origin as advertised: http(s)://host:port, nothing after it. */
export const originSchema = z.string().max(200).refine((value) => {
  try { const url = new URL(value); return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value; } catch { return false; }
}, "Invalid origin");

export const wireEntrySchema = z.object({
  p: z.string().min(1).max(16_384),
  t: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  s: safeInt,
  m: z.number().finite(),
  o: z.number().int().min(0).max(0o777),
  h: hex64.nullable().optional(),
  l: z.string().min(1).max(4096).refine((value) => !value.includes("\0"), "Link text contains NUL").nullable().optional(),
  d: z.boolean().optional(),
  v: vectorSchema,
  b: nodeIdSchema,
  q: safeInt,
});
export type WireEntry = z.infer<typeof wireEntrySchema>;

/** Short keys; null hash/link and live state are left out. */
export function toWire(entry: IndexEntry): WireEntry {
  return {
    p: entry.path, t: entry.type, s: entry.size, m: entry.mtimeMs, o: entry.mode,
    ...(entry.sha256 !== null ? { h: entry.sha256 } : {}),
    ...(entry.target !== null ? { l: entry.target } : {}),
    ...(entry.deleted ? { d: true } : {}),
    v: entry.version, b: entry.modifiedBy, q: entry.seq,
  };
}

function entryProblem(entry: IndexEntry): string | null {
  if (entry.sha256 !== null && entry.type !== FILE) return "only files carry a hash";
  if (entry.target !== null && entry.type !== SYMLINK) return "only symbolic links carry a target";
  if (!entry.deleted && entry.type === FILE && entry.sha256 === null) return "a live file needs its hash";
  if (!entry.deleted && entry.type === SYMLINK && entry.target === null) return "a live symbolic link needs its target";
  return null;
}

/** Validated index entries with NFC paths. Throws WireError naming the first bad entry. */
export function fromWire(entries: unknown): IndexEntry[] {
  if (!Array.isArray(entries)) throw new WireError("Index entries must be an array");
  const seen = new Set<string>();
  return entries.map((value, index) => {
    const parsed = wireEntrySchema.safeParse(value);
    if (!parsed.success) throw new WireError(`Invalid index entry ${index}: ${parsed.error.issues[0]?.message ?? "malformed"}`);
    const wire = parsed.data;
    let path: string;
    try { path = normalizeRelativePath(wire.p); } catch (error) {
      throw new WireError(`Invalid index entry ${index}: ${error instanceof Error ? error.message : "bad path"}`);
    }
    const entry: IndexEntry = {
      path, type: wire.t, size: wire.s, mtimeMs: wire.m, mode: wire.o,
      sha256: wire.h ?? null, target: wire.l ?? null, deleted: wire.d ?? false,
      version: wire.v as Vector, modifiedBy: wire.b, seq: wire.q,
    };
    const problem = entryProblem(entry);
    if (problem) throw new WireError(`Invalid index entry ${index}: ${problem}`);
    if (seen.has(path)) throw new WireError(`Invalid index entry ${index}: duplicate path`);
    seen.add(path);
    return entry;
  });
}

const indexPageHeader = z.object({
  indexId: indexIdSchema,
  maxSeq: safeInt,
  digest: hex64,
  prunedBelow: safeInt,
  builtinSince: safeInt.nullable(),
  entries: z.array(z.unknown()).max(INDEX_PAGE_LIMIT),
  more: z.boolean(),
});
export interface IndexPage { indexId: string; maxSeq: number; digest: string; prunedBelow: number; builtinSince: number | null; entries: IndexEntry[]; more: boolean }

export function parseIndexPage(value: unknown): IndexPage {
  const parsed = indexPageHeader.safeParse(value);
  if (!parsed.success) throw new WireError(`Invalid index page: ${parsed.error.issues[0]?.message ?? "malformed"}`);
  return { ...parsed.data, entries: fromWire(parsed.data.entries) };
}

export async function encodeIndexPage(page: IndexPage): Promise<Buffer> {
  return gzipAsync(Buffer.from(JSON.stringify({ ...page, entries: page.entries.map(toWire) }), "utf8"));
}

export async function decodeIndexPage(body: Uint8Array, maxBytes = INDEX_PAGE_MAX_BYTES): Promise<IndexPage> {
  let json: Buffer;
  try { json = await gunzipAsync(body, { maxOutputLength: maxBytes }); } catch (error) {
    throw new WireError((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" ? "Index page is too large" : "Index page is not gzip");
  }
  let value: unknown;
  try { value = JSON.parse(json.toString("utf8")); } catch { throw new WireError("Index page is not JSON"); }
  return parseIndexPage(value);
}

/** Path plus query, exactly as signed and sent. */
export function filesTarget(endpoint: FilesEndpoint, query?: Record<string, string | number>): string {
  const search = query ? new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)])).toString() : "";
  return `${FILES_API}/${endpoint}${search ? `?${search}` : ""}`;
}

const decimal = (min: number, max: number) => z.string().regex(/^(0|[1-9][0-9]{0,15})$/).transform(Number).pipe(z.number().int().min(min).max(max));

const engineRecordSchema = z.object({ projectId: projectIdSchema, mode: z.enum(["syncthing", "builtin"]), generation: safeInt, updatedAt: z.string().datetime({ offset: true }), origin: nodeIdSchema });
const ruleList = z.array(z.string().max(1000)).max(1000);
const settingsRecordSchema = z.object({
  key: z.string().regex(/^(project|global):.{1,240}$/),
  value: z.object({ disabledBuiltins: ruleList, userRules: ruleList, removedUserRules: ruleList, gitignore: z.boolean(), importedFrom: z.array(nodeIdSchema).max(1000) }),
  updatedAt: z.string().datetime({ offset: true }),
  origin: nodeIdSchema,
});
const protocolNumber = z.number().int().positive().max(1_000_000);

/** `/hello` body part and answer part (§1 Capability). */
export const helloBodySchema = z.object({ protocol: protocolNumber, origins: z.array(originSchema).max(16) });
export const helloAnswerSchema = z.object({ protocol: protocolNumber, minProtocol: protocolNumber, origins: z.array(originSchema).max(16) });

/** GET …/files/shares */
export const sharesAnswerSchema = z.object({
  fileSync: z.object({ protocol: protocolNumber, minProtocol: protocolNumber, enabled: z.boolean() }),
  nodeId: nodeIdSchema,
  hostId: z.string().min(1).max(200),
  origins: z.array(originSchema).max(16),
  shares: z.array(z.object({
    projectId: projectIdSchema,
    kind: shareKindSchema,
    indexId: indexIdSchema,
    maxSeq: safeInt,
    digest: hex64,
    rulesHash: hex64,
    state: shareStateSchema,
    builtinSince: safeInt.nullable(),
    prunedBelow: safeInt,
    rootDev: z.number().finite().min(0).nullable(),
    rootIno: z.number().finite().min(0).nullable(),
  })).max(30_000),
  engines: z.array(engineRecordSchema).max(10_000),
  settings: z.array(settingsRecordSchema).max(20_000),
});

/** GET …/files/index query (URLSearchParams values). */
export const indexQuerySchema = z.object({
  projectId: projectIdSchema,
  kind: shareKindSchema,
  since: decimal(0, Number.MAX_SAFE_INTEGER).default("0"),
  limit: decimal(1, INDEX_PAGE_LIMIT).default(String(INDEX_PAGE_LIMIT)),
});
/** The JSON inside the gzip answer of …/files/index, before entries are validated (see parseIndexPage). */
export const indexPageSchema = indexPageHeader;

/** POST …/files/changed */
export const changedBodySchema = z.object({
  shares: z.array(z.object({ projectId: projectIdSchema, kind: shareKindSchema, indexId: indexIdSchema, maxSeq: safeInt })).max(30_000),
  records: z.boolean().optional(),
});

/** POST …/files/fetch (answer: frames.ts) */
export const fetchBodySchema = z.object({
  projectId: projectIdSchema,
  kind: shareKindSchema,
  items: z.array(z.object({ path: relativePathSchema, sha256: hex64 })).min(1).max(FETCH_ITEM_LIMIT),
});

/** POST …/files/file (+ Range; answer: bytes or 409 {"error":"changed"}) */
export const fileBodySchema = z.object({ projectId: projectIdSchema, kind: shareKindSchema, path: relativePathSchema, sha256: hex64 });

/** POST …/files/status */
export const statusBodySchema = z.object({
  projectId: projectIdSchema,
  shares: z.array(z.object({ kind: shareKindSchema, indexId: indexIdSchema, maxSeq: safeInt })).max(3).optional(),
});
export const statusAnswerSchema = z.object({
  shares: z.array(z.object({
    kind: shareKindSchema,
    state: shareStateSchema,
    cursor: safeInt,
    callerIndexId: indexIdSchema.nullable(),
    need: z.object({ files: safeInt, bytes: safeInt }),
    blocked: safeInt,
    errors: safeInt,
    digest: hex64,
    maxSeq: safeInt,
  })).max(3),
});

/** Any non-2xx JSON answer: 403 {error: NOT_SHARED_ERROR}, 409 {error: "changed"}, … */
export const errorAnswerSchema = z.object({ error: z.string().max(2000) });

export type HelloBody = z.infer<typeof helloBodySchema>;
export type HelloAnswer = z.infer<typeof helloAnswerSchema>;
export type SharesAnswer = z.infer<typeof sharesAnswerSchema>;
export type ShareAnnouncement = SharesAnswer["shares"][number];
export type IndexQuery = z.output<typeof indexQuerySchema>;
export type ChangedBody = z.infer<typeof changedBodySchema>;
export type FetchBody = z.output<typeof fetchBodySchema>;
export type FileBody = z.output<typeof fileBodySchema>;
export type StatusBody = z.infer<typeof statusBodySchema>;
export type StatusAnswer = z.infer<typeof statusAnswerSchema>;
