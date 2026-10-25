import type { FileSyncDb } from "./db.js";
import type { NeedEngine } from "./need.js";
import { FILE_SYNC_MIN_PROTOCOL, FILE_SYNC_PROTOCOL, type ConfigureArgs, type CoreEvent, type ShareSpec } from "./protocol.js";
import type { Announced } from "./service.js";
import { shareKey, type Clock } from "./types.js";
import { decodeIndexPage, filesTarget, INDEX_PAGE_LIMIT, sharesAnswerSchema, type IndexPage, type SharesAnswer } from "./wire.js";

/* The client half of the protocol (FILE-SYNC design §6.2): pulls, notices and the capability probe,
   per peer behind a small limiter. Nothing here polls: a pull starts on a notice, a status request,
   start, wake, a peer's return or a newly shared folder; a failed delivery to a peer that is present
   is retried with backoff, and nothing is retried while it is away. */

export interface PeerRequest {
  method: "GET" | "POST";
  /** Path and query under /api/cluster/v2/files, exactly as signed and sent. */
  target: string;
  json?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  purpose: "notice" | "index" | "transfer" | "status" | "shares";
  /** "relay": only through main, whose channel authenticates the answer too; never a direct origin. */
  via?: "relay";
}
export interface PeerResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
  /** The route that carried it, when the transport knows: a direct answer is plain HTTP that nothing signs. */
  route?: "direct" | "relay";
}
export interface PeerTransport {
  request(peer: string, request: PeerRequest): Promise<PeerResponse>;
  /** The route the last request to a peer took, for status. */
  route?(peer: string): "direct" | "relay" | "none";
  /** The peer reached us after it looked away: its addresses deserve a new try. */
  reachable?(peer: string): void;
}

export interface SyncShare { spec: ShareSpec; rulesHash: string }

export interface SyncDeps {
  db: FileSyncDb;
  nodeId: string;
  clock: Clock;
  transport: PeerTransport;
  need: NeedEngine;
  emit(event: CoreEvent): void;
  shares(): ReadonlyMap<string, SyncShare>;
  hostId(): string;
  /** A pull ended or a peer's announcement or comparison moved: the share's status goes out. */
  stateChanged(key: string): void;
  /** Tests: shorter coalescing, and smaller pages to exercise paging. */
  noticeDelayMs?: number;
  pageLimit?: number;
}

const NOTICE_DELAY_MS = 250;
const MAX_BACKOFF_MS = 300_000;
const MAX_IN_FLIGHT = 4;
const MAX_INDEX_PULLS = 2;
/** A compressed page of 5,000 entries is a few hundred KB; this only stops a peer from filling memory. */
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const DIGEST_MISMATCH = "Index does not match its digest after a repair";

type Capability = "unknown" | "capable" | "incapable";
type Timer = { cancel(): void };

/**
 * ≤ 4 requests in flight per peer, ≤ 2 of them index pulls; notices take no slot (they are tiny and
 * must not wait behind bulk work); a person's request goes ahead of queued background ones.
 */
export class PeerLimiter {
  private inFlight = 0;
  private pulls = 0;
  private readonly queue: Array<{ index: boolean; urgent: boolean; start: () => void }> = [];

  acquire(purpose: PeerRequest["purpose"], urgent = false): Promise<() => void> {
    if (purpose === "notice") return Promise.resolve(() => {});
    const index = purpose === "index";
    return new Promise((resolve) => {
      const start = () => {
        this.inFlight++;
        if (index) this.pulls++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.inFlight--;
          if (index) this.pulls--;
          this.pump();
        });
      };
      const waiter = { index, urgent, start };
      // Urgent ones queue behind earlier urgent ones only.
      if (urgent) {
        const at = this.queue.findIndex((queued) => !queued.urgent);
        if (at < 0) this.queue.push(waiter); else this.queue.splice(at, 0, waiter);
      } else this.queue.push(waiter);
      this.pump();
    });
  }

  private fits(index: boolean): boolean { return this.inFlight < MAX_IN_FLIGHT && (!index || this.pulls < MAX_INDEX_PULLS); }

  private pump(): void {
    // A pull held back by the pull cap does not hold back other requests behind it.
    for (let at = 0; at < this.queue.length && this.inFlight < MAX_IN_FLIGHT;) {
      if (this.fits(this.queue[at].index)) this.queue.splice(at, 1)[0].start(); else at++;
    }
  }

  get active(): { inFlight: number; pulls: number; queued: number } { return { inFlight: this.inFlight, pulls: this.pulls, queued: this.queue.length }; }
}

interface PeerState {
  id: string;
  present: boolean;
  capability: Capability;
  protocol: number;
  enabled: boolean;
  /** Its engine is off (its shares answer says so) or not ready (a notice got 503): nothing is noticed until a probe or its own notice says otherwise. */
  off: boolean;
  origins: string[];
  hostId?: string;
  limiter: PeerLimiter;
  lastCapability?: string;
  lastRecords?: string;
  contacting?: Promise<void>;
  /** A trigger that needs an answer newer than the one in flight (a notice from the peer itself). */
  contactAgain: boolean;
  /** The next successful contact notices every share (start, wake, return, a newly shared folder). */
  contactNotify: boolean;
  contactAttempts: number;
  contactRetry?: Timer;
  /** Shares the peer does not serve us (left out of its shares answer, or refused): not noticed until it names them again. */
  refused: Set<string>;
  /** Shares changed since the last notice (coalescing window). */
  pending: Set<string>;
  noticeTimer?: Timer;
  /** Shares whose notice could not be delivered; sent again with backoff while present. */
  outbox: Set<string>;
  outboxAttempts: number;
  outboxRetry?: Timer;
  sending?: Promise<void>;
}

interface Notice { projectId: string; kind: string; indexId: string; maxSeq: number; rulesHash: string }

interface PullState { peer: string; key: string; running?: Promise<void>; dirty: boolean; urgent: boolean; reset: boolean; attempts: number; retry?: Timer }

class Fetched { constructor(readonly status: number, readonly headers: Record<string, string>, readonly bytes: Buffer, readonly route?: "direct" | "relay") {} }

async function readBody(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error("Answer is too large");
    chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  }
  return Buffer.concat(chunks, total);
}

async function discard(body: AsyncIterable<Uint8Array>): Promise<void> {
  try { for await (const _chunk of body) { /* drained so the connection can be reused */ } } catch { /* nothing to keep */ }
}

function backoff(attempts: number): number { return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, attempts - 1)); }

/** A 503 from the peer's engine (main's routes with file sync off, or an engine still starting), not a relay's own (machine offline). */
function engineNotRunning(fetched: Fetched): boolean {
  try {
    const error = (JSON.parse(fetched.bytes.toString("utf8")) as { error?: unknown }).error;
    return typeof error === "string" && /^File sync is (off|starting)\b/.test(error);
  } catch {
    return false;
  }
}

function recordsText(answer: SharesAnswer): string | undefined {
  return answer.engines.length || answer.settings.length ? JSON.stringify([answer.engines, answer.settings]) : undefined;
}

export class SyncLayer {
  private readonly peers = new Map<string, PeerState>();
  private readonly pulls = new Map<string, PullState>();
  private readonly inflight = new Set<Promise<unknown>>();
  /** `share\npeer` pairs of the last configure, so a newly shared folder is pulled at once. */
  private pairs = new Set<string>();
  /** Same-folder guard: `share\npeer` of a peer on this machine whose share root is literally ours. */
  private readonly excluded = new Set<string>();
  /** Live consistency check: pairs repaired once for a digest mismatch, and pairs whose mismatch persisted. */
  private readonly repaired = new Set<string>();
  private readonly mismatched = new Set<string>();
  private readonly abort = new AbortController();
  private closed = false;

  constructor(private readonly deps: SyncDeps) {}

  // ---- state ----

  private peer(id: string): PeerState {
    let state = this.peers.get(id);
    if (!state) {
      state = {
        id, present: false, capability: "unknown", protocol: 0, enabled: false, off: false, origins: [], limiter: new PeerLimiter(),
        contactAgain: false, contactNotify: false, contactAttempts: 0, refused: new Set(), pending: new Set(), outbox: new Set(), outboxAttempts: 0,
      };
      this.peers.set(id, state);
    }
    return state;
  }

  /** Background work: tracked for idle(), and never a rejection nobody handles (in a worker that would end the thread). */
  private track(key: string, work: () => Promise<void>, done?: () => void): Promise<void> {
    const promise: Promise<void> = work().catch((error) => {
      if (!this.closed) this.warn(key, `File sync: ${(error as Error).message}`);
    }).finally(() => {
      this.inflight.delete(promise);
      done?.();
    });
    this.inflight.add(promise);
    return promise;
  }

  private warn(key: string, message: string): void { this.deps.emit({ event: "log", level: "warn", key, message }); }

  private sharesWith(peer: string): Array<[string, SyncShare]> {
    return [...this.deps.shares()].filter(([key, share]) => share.spec.peers.includes(peer) && !this.isExcluded(key, peer));
  }

  /** Whether a notice about this share (or any, without one) can mean something to the peer now. */
  private noticeable(state: PeerState, key?: string): boolean {
    return state.present && state.capability !== "incapable" && !state.off && (key === undefined || !state.refused.has(key));
  }

  isExcluded(key: string, peer: string): boolean { return this.excluded.has(`${key}\n${peer}`); }

  route(peer: string): "direct" | "relay" | "none" { return this.deps.transport.route?.(peer) ?? "none"; }

  /** Whether a pull of this pair is running or queued (tests and status). */
  pulling(key: string, peer: string): boolean { return Boolean(this.pulls.get(`${key}\n${peer}`)?.running); }

  mismatch(key: string): string[] { return [...this.mismatched].filter((pair) => pair.startsWith(`${key}\n`)).map((pair) => pair.slice(key.length + 1)); }

  /** Resolves once no request, pull or notice is running (tests; stop). Coalescing and retry timers are not waited for. */
  async idle(): Promise<void> {
    while (this.inflight.size || this.deps.need.busy) {
      await Promise.allSettled([...this.inflight]);
      await this.deps.need.idle();
    }
  }

  // ---- triggers ----

  /** The desired state: presence from main, and a contact for every peer that shares a folder with us for the first time. */
  configure(args: ConfigureArgs): void {
    if (this.closed) return;
    const pairs = new Set<string>();
    const contact = new Set<string>();
    const shares = args.enabled ? args.shares : [];
    for (const share of shares) {
      for (const peer of share.peers) {
        const pair = `${share.key}\n${peer}`;
        pairs.add(pair);
        if (!this.pairs.has(pair)) contact.add(peer);
      }
    }
    const removed = [...this.pairs].filter((pair) => !pairs.has(pair));
    this.pairs = pairs;
    const listed = new Set(args.peers.map((peer) => peer.nodeId));
    for (const spec of args.peers) {
      const state = this.peer(spec.nodeId);
      const returned = spec.present && !state.present;
      state.present = spec.present;
      if (spec.origins.length) state.origins = spec.origins;
      if (returned) contact.add(spec.nodeId);
      if (!spec.present) this.cancelRetries(state);
    }
    for (const [id, state] of this.peers) {
      if (listed.has(id) || [...pairs].some((pair) => pair.endsWith(`\n${id}`))) continue;
      this.forget(state);
    }
    for (const pair of removed) {
      const [key, peer] = pair.split("\n");
      this.excluded.delete(pair);
      const pull = this.pulls.get(pair);
      pull?.retry?.cancel();
      if (!pull?.running) this.pulls.delete(pair);
      this.deps.need.syncComparison(key, peer);
    }
    // Peers listed only so their signatures verify (no shared folder) are never contacted.
    for (const peer of contact) if (this.peer(peer).present && this.sharesWith(peer).length) this.contact(peer, { notify: true });
  }

  /** announce: start, wake or join. One shares request per peer that may run the engine, then pulls and one notice each. */
  announce(slept: boolean): void {
    if (this.closed) return;
    for (const state of this.peers.values()) {
      // Main forgot who was away when this node slept (its availability starts over): so does this.
      if (slept) state.present = true;
      if (!state.present || !this.sharesWith(state.id).length) continue;
      // After a sleep a peer may have been updated meanwhile: ask again even if it was too old before.
      if (state.capability === "incapable" && !slept) continue;
      this.contact(state.id, { notify: true });
    }
  }

  presence(peer: string, present: boolean, origins?: string[]): void {
    const state = this.peer(peer);
    if (origins?.length) state.origins = origins;
    state.present = present;
    if (!present) { this.cancelRetries(state); return; }
    // Back again, maybe updated: the probe decides what it can do now.
    if (state.capability === "incapable") state.capability = "unknown";
    if (this.sharesWith(peer).length) this.contact(peer, { notify: true });
  }

  /** Local rows changed (a scan commit, merges): peers hear about it after a short coalescing window. */
  localCommitted(key: string): void {
    const share = this.deps.shares().get(key);
    if (!share || this.closed) return;
    for (const peer of share.spec.peers) {
      if (this.isExcluded(key, peer)) continue;
      const state = this.peer(peer);
      if (!this.noticeable(state, key)) continue;
      state.pending.add(key);
      state.noticeTimer ??= this.deps.clock.setTimeout(() => {
        state.noticeTimer = undefined;
        this.sendNotices(state);
      }, this.deps.noticeDelayMs ?? NOTICE_DELAY_MS);
    }
  }

  /** An authorized `changed` notice arrived (directly, or through main as the notice op). */
  noticeReceived(peer: string, shares: Announced[], records: boolean): void {
    if (this.closed) return;
    const state = this.peer(peer);
    // It reached us, so it is around and runs the engine; whatever we owe it goes now.
    const returned = this.reached(state);
    for (const share of shares) state.refused.delete(share.key);
    // Its engine runs and serves these now: an older probe saying otherwise is stale, and records it asks us to fetch are
    // newer than any answer in flight. Notices dropped while its engine was off are made up for with one for every share.
    if (state.capability !== "capable" || state.off || records) this.contact(peer, { notify: returned || state.off, fresh: true });
    // Back from away: what changed here meanwhile was never noticed to it.
    else if (returned) this.flush(state, true);
    this.announced(peer, shares, false);
    if (state.outbox.size && this.noticeable(state)) this.sendNotices(state);
  }

  /** An authorized `status` request: whatever the caller has that we do not is pulled at once. */
  statusReceived(peer: string, shares: Announced[]): void {
    if (this.closed) return;
    const state = this.peer(peer);
    if (this.reached(state) && this.noticeable(state)) this.flush(state, true);
    this.announced(peer, shares, true);
    if (state.outbox.size && this.noticeable(state)) this.sendNotices(state);
  }

  /** Whether it was away until now. */
  private reached(state: PeerState): boolean {
    if (state.present) return false;
    state.present = true;
    this.deps.transport.reachable?.(state.id);
    return true;
  }

  /** Drop the peer's rows and cursor for the share and pull its whole index again. */
  repair(key: string, peer: string, urgent = true): void {
    const pull = this.pullState(key, peer);
    pull.reset = true;
    this.schedulePull(peer, key, urgent);
  }

  private announced(peer: string, shares: Announced[], urgent: boolean): void {
    const { db } = this.deps;
    const behind: string[] = [];
    const rules: string[] = [];
    const changed = new Set<string>();
    const now = this.deps.clock.now();
    db.writeTx(() => {
      for (const share of shares) {
        if (this.isExcluded(share.key, peer)) continue;
        const cursor = db.cursor(share.key, peer);
        const current = cursor?.peerIndexId !== share.indexId || share.maxSeq >= (cursor?.peerMaxSeq ?? 0);
        // A notice carries no digest: the stored one stays paired with an older maxSeq until the next page or shares answer.
        if (cursor?.peerIndexId !== share.indexId || share.maxSeq > (cursor?.peerMaxSeq ?? 0)) {
          db.updateCursor(share.key, peer, { peerIndexId: share.indexId, peerMaxSeq: share.maxSeq }, now);
          changed.add(share.key);
        }
        // A share the peer started serving after our last shares request, or whose rules it changed: comparable or not from
        // now on. A notice overtaken by a newer one says less than what we hold: its rules may no longer hold.
        if (share.rulesHash && current && cursor?.peerRulesHash !== share.rulesHash) {
          db.updateCursor(share.key, peer, { peerRulesHash: share.rulesHash }, now);
          rules.push(share.key);
          changed.add(share.key);
        }
        if (cursor?.indexId !== share.indexId || share.maxSeq > cursor.seq) behind.push(share.key);
      }
    });
    for (const key of rules) this.deps.need.syncComparison(key, peer);
    // A pull reports when it ends; an unchanged announcement changes no status.
    for (const key of changed) this.deps.stateChanged(key);
    for (const key of behind) this.schedulePull(peer, key, urgent);
  }

  // ---- requests ----

  /** One request through the peer's limiter; the slot is held until the whole (bounded) answer is read. A 401 is retried once. */
  private async fetch(peer: string, request: Omit<PeerRequest, "signal">, maxBytes: number, urgent = false): Promise<Fetched> {
    const state = this.peer(peer);
    const release = await state.limiter.acquire(request.purpose, urgent);
    try {
      for (let attempt = 0; ; attempt++) {
        if (this.closed) throw new Error("File sync is stopping");
        let response: PeerResponse;
        try {
          response = await this.deps.transport.request(peer, { ...request, signal: this.abort.signal });
        } catch (error) {
          // Main has the peer as away (the relay leg was refused or failed): it reports the return, which ends this.
          if ((error as { away?: unknown })?.away === true) this.away(state);
          throw error;
        }
        // Signed when the slot was granted; a long wait can still outlive the receiver's clock window once.
        if (response.status === 401 && attempt === 0) { await discard(response.body); continue; }
        return new Fetched(response.status, response.headers, await readBody(response.body, maxBytes), response.route);
      }
    } finally {
      release();
    }
  }

  /** Nothing more goes to the peer in the background until main reports it back, it reaches us, or this node wakes (§0.11). */
  private away(state: PeerState): void {
    if (!state.present) return;
    state.present = false;
    this.cancelRetries(state);
  }

  // ---- contact: capability, announcements, records ----

  /**
   * One shares request at a time per peer. A trigger while one is in flight folds into it (its answer
   * is as fresh as the trigger), except the peer's own notice: it may have changed after answering.
   */
  private contact(peer: string, options: { notify: boolean; fresh?: boolean }): void {
    if (this.closed) return;
    const state = this.peer(peer);
    state.contactNotify ||= options.notify;
    if (state.contacting) { state.contactAgain ||= Boolean(options.fresh); return; }
    state.contactRetry?.cancel();
    state.contactRetry = undefined;
    state.contacting = this.track(`fileSync:peer:${peer}`, () => this.runContact(state), () => { state.contacting = undefined; });
  }

  private async runContact(state: PeerState): Promise<void> {
    do {
      state.contactAgain = false;
      if (!state.present || this.closed) return;
      let fetched: Fetched;
      try {
        fetched = await this.fetch(state.id, { method: "GET", target: filesTarget("shares"), purpose: "shares" }, MAX_JSON_BYTES);
      } catch (error) {
        this.contactFailed(state, (error as Error).message);
        return;
      }
      // An old node answers an unknown signed /files/* request with 404: it cannot sync files this way.
      if (fetched.status === 404) { this.setCapability(state, "incapable"); return; }
      if (fetched.status !== 200) { this.contactFailed(state, `HTTP ${fetched.status}`); return; }
      const answer = this.sharesAnswer(state, fetched);
      if (!answer) return;
      state.contactAttempts = 0;
      state.origins = answer.origins;
      state.hostId = answer.hostId;
      state.protocol = answer.fileSync.protocol;
      state.enabled = answer.fileSync.enabled;
      state.off = !answer.fileSync.enabled;
      const compatible = answer.fileSync.minProtocol <= FILE_SYNC_PROTOCOL && answer.fileSync.protocol >= FILE_SYNC_MIN_PROTOCOL;
      this.setCapability(state, compatible ? "capable" : "incapable");
      if (!compatible || state.off) { state.contactNotify = false; continue; }
      this.applyShares(state, answer);
      const notify = state.contactNotify;
      state.contactNotify = false;
      this.flush(state, notify);
      await this.forwardRecords(state, answer, fetched.route);
    } while (state.contactAgain && !this.closed);
  }

  private sharesAnswer(state: PeerState, fetched: Fetched): SharesAnswer | undefined {
    let answer: SharesAnswer;
    try {
      answer = sharesAnswerSchema.parse(JSON.parse(fetched.bytes.toString("utf8")));
    } catch {
      this.warn(`fileSync:peer:${state.id}`, `File sync could not read the shares answer of ${state.id}`);
      return undefined;
    }
    if (answer.nodeId !== state.id) {
      this.warn(`fileSync:peer:${state.id}`, `File sync got a shares answer from ${answer.nodeId} when asking ${state.id}`);
      return undefined;
    }
    return answer;
  }

  private contactFailed(state: PeerState, reason: string): void {
    if (this.closed || !state.present) return;
    state.contactAttempts++;
    const delay = backoff(state.contactAttempts);
    if (state.contactAttempts === 1) this.warn(`fileSync:peer:${state.id}`, `File sync could not reach ${state.id} (${reason}); trying again in ${Math.round(delay / 1000)} s`);
    state.contactRetry?.cancel();
    state.contactRetry = this.deps.clock.setTimeout(() => {
      state.contactRetry = undefined;
      if (state.present) this.contact(state.id, { notify: false });
    }, delay);
  }

  private setCapability(state: PeerState, capability: Capability): void {
    state.capability = capability;
    // Nothing it could act on: notices for it are dropped rather than retried forever.
    if (capability === "incapable" || state.off) this.dropNotices(state);
    const event = {
      event: "capability" as const, peer: state.id, protocol: state.protocol, enabled: capability === "capable" && state.enabled,
      origins: capability === "incapable" ? [] : state.origins, ...(state.hostId ? { hostId: state.hostId } : {}),
    };
    const text = JSON.stringify(event);
    if (text === state.lastCapability) return;
    state.lastCapability = text;
    this.deps.emit(event);
  }

  private dropNotices(state: PeerState): void {
    state.outbox.clear();
    state.pending.clear();
    state.noticeTimer?.cancel();
    state.noticeTimer = undefined;
    this.cancelRetries(state);
  }

  /**
   * Records go to main with the sender this node authenticated; main decides what it accepts (owner,
   * origin). A direct answer is plain HTTP from whatever holds that address, so new records are
   * fetched again through main, whose channel authenticates the peer.
   */
  private async forwardRecords(state: PeerState, answer: SharesAnswer, route: Fetched["route"]): Promise<void> {
    const text = recordsText(answer);
    if (text === undefined || text === state.lastRecords) return;
    let trusted = answer;
    if (route === "direct") {
      let fetched: Fetched;
      try {
        fetched = await this.fetch(state.id, { method: "GET", target: filesTarget("shares"), purpose: "shares", via: "relay" }, MAX_JSON_BYTES);
      } catch (error) {
        this.warn(`fileSync:peer:${state.id}:records`, `File sync could not fetch the settings of ${state.id} through the relay: ${(error as Error).message}`);
        return;
      }
      const relayed = fetched.status === 200 ? this.sharesAnswer(state, fetched) : undefined;
      if (!relayed) return;
      trusted = relayed;
    }
    const trustedText = recordsText(trusted);
    if (trustedText === undefined || trustedText === state.lastRecords) return;
    state.lastRecords = trustedText;
    this.deps.emit({ event: "records", fromPeer: state.id, engines: trusted.engines, settings: trusted.settings });
  }

  private applyShares(state: PeerState, answer: SharesAnswer): void {
    const { db } = this.deps;
    const hostId = this.deps.hostId();
    const local = this.deps.shares();
    const behind: string[] = [];
    const touched: string[] = [];
    const changed = new Set<string>();
    const now = this.deps.clock.now();
    const served = new Set<string>();
    db.writeTx(() => {
      for (const announced of answer.shares) {
        const key = shareKey(announced);
        const share = local.get(key);
        if (!share || !share.spec.peers.includes(state.id)) continue;
        served.add(key);
        touched.push(key);
        const row = db.share(key);
        const pair = `${key}\n${state.id}`;
        // Two nodes on one machine whose share is literally the same folder: syncing it with itself would only race.
        if (answer.hostId === hostId && announced.rootIno !== null && row?.rootIno === announced.rootIno && row.rootDev === announced.rootDev) {
          if (!this.excluded.has(pair)) {
            this.excluded.add(pair);
            changed.add(key);
            this.warn(`fileSync:${key}:same-folder`, `File sync leaves ${key} out with ${state.id}: both nodes use the same folder on this machine`);
          }
          continue;
        }
        if (this.excluded.delete(pair)) changed.add(key);
        const before = db.cursor(key, state.id);
        // An answer a notice overtook (same generation, lower maxSeq) is older than what we hold: its digest and rules too.
        const stale = before?.peerIndexId === announced.indexId && announced.maxSeq < before.peerMaxSeq;
        if (!stale && (before?.peerIndexId !== announced.indexId || before.peerMaxSeq !== announced.maxSeq || before.peerDigest !== announced.digest
          || before.peerRulesHash !== announced.rulesHash || before.peerBuiltinSince !== announced.builtinSince)) {
          changed.add(key);
          db.updateCursor(key, state.id, {
            peerIndexId: announced.indexId, peerMaxSeq: announced.maxSeq, peerDigest: announced.digest,
            peerRulesHash: announced.rulesHash, peerBuiltinSince: announced.builtinSince,
          }, now);
        }
        const cursor = db.cursor(key, state.id)!;
        // A prune above our cursor implies maxSeq above it too: the pull sees it and resets.
        if (stale ? this.behind(key, state.id) : cursor.indexId !== announced.indexId || cursor.seq !== announced.maxSeq) behind.push(key);
      }
    });
    // What it left out is not served to us there (not derived yet, or not shared): no notices until it names them.
    state.refused.clear();
    for (const [key] of this.sharesWith(state.id)) if (!served.has(key)) state.refused.add(key);
    for (const key of touched) {
      // Its rules hash may match ours now (or no longer), or it was left out as the same folder.
      this.deps.need.syncComparison(key, state.id);
      if (changed.has(key)) this.deps.stateChanged(key);
    }
    for (const key of behind) this.schedulePull(state.id, key, false);
    // Caught up already (a restart, an idle project): the check runs on what is stored, and clears an error that no longer holds.
    for (const key of touched) if (!behind.includes(key)) this.liveCheck(key, state.id);
  }

  // ---- pulls ----

  private pullState(key: string, peer: string): PullState {
    const id = `${key}\n${peer}`;
    let pull = this.pulls.get(id);
    if (!pull) { pull = { peer, key, dirty: false, urgent: false, reset: false, attempts: 0 }; this.pulls.set(id, pull); }
    return pull;
  }

  /** Single flight per (peer, share): a trigger during a pull marks it dirty and the loop goes once more. */
  schedulePull(peer: string, key: string, urgent = false): void {
    if (this.closed) return;
    const pull = this.pullState(key, peer);
    pull.urgent ||= urgent;
    if (pull.running) { pull.dirty = true; return; }
    pull.retry?.cancel();
    pull.retry = undefined;
    pull.running = this.track(`fileSync:${key}:pull:${peer}`, () => this.runPull(pull), () => {
      pull.running = undefined;
      if (pull.dirty && !this.closed) this.schedulePull(peer, key);
    });
  }

  private async runPull(pull: PullState): Promise<void> {
    const { db, need } = this.deps;
    const { peer, key } = pull;
    for (;;) {
      pull.dirty = false;
      const state = this.peer(peer);
      const share = this.deps.shares().get(key);
      if (this.closed || !state.present || state.capability === "incapable" || !share || !share.spec.peers.includes(peer) || this.isExcluded(key, peer)) return;
      if (pull.reset) {
        pull.reset = false;
        need.resetPeer(key, peer);
        need.syncComparison(key, peer);
      }
      const cursor = db.cursor(key, peer);
      const since = cursor?.indexId ? cursor.seq : 0;
      const query: Record<string, string | number> = { projectId: share.spec.projectId, kind: share.spec.kind, since, limit: this.deps.pageLimit ?? INDEX_PAGE_LIMIT };
      if (cursor?.indexId) query.indexId = cursor.indexId;
      let fetched: Fetched;
      try {
        fetched = await this.fetch(peer, { method: "GET", target: filesTarget("index", query), purpose: "index" }, MAX_INDEX_BYTES, pull.urgent);
      } catch (error) {
        this.pullFailed(pull, (error as Error).message);
        return;
      }
      if (fetched.status === 404) { this.setCapability(state, "incapable"); return; }
      // Not shared on its side (yet): it contacts us once it derives the share.
      if (fetched.status === 403) { state.refused.add(key); return; }
      if (fetched.status !== 200) { this.pullFailed(pull, `HTTP ${fetched.status}`); return; }
      let page: IndexPage;
      try {
        page = await decodeIndexPage(fetched.bytes);
        if (this.closed) return;
        const stored = await need.storeRemote(key, peer, since, page);
        if (stored.restart) continue;
      } catch (error) {
        if (this.closed) return;
        this.pullFailed(pull, (error as Error).message);
        return;
      }
      // Any answer is contact: notices we owe it go now.
      if (state.outbox.size && !state.sending && this.noticeable(state)) this.sendNotices(state);
      if (page.more || pull.reset) continue;
      // A trigger during the pull goes once more only if it announced more than this pull reached.
      if (pull.dirty && this.behind(key, peer)) continue;
      pull.dirty = false;
      break;
    }
    pull.attempts = 0;
    pull.urgent = false;
    need.syncComparison(key, peer);
    this.liveCheck(key, peer, true);
    this.deps.stateChanged(key);
  }

  /** Our copy is not at what the peer announced last (another generation, or a lower seq). */
  private behind(key: string, peer: string): boolean {
    const cursor = this.deps.db.cursor(key, peer);
    return !cursor?.indexId || cursor.indexId !== (cursor.peerIndexId ?? cursor.indexId) || cursor.seq < cursor.peerMaxSeq;
  }

  private pullFailed(pull: PullState, reason: string): void {
    if (this.closed) return;
    const state = this.peer(pull.peer);
    if (!state.present) return;
    pull.attempts++;
    const delay = backoff(pull.attempts);
    if (pull.attempts === 1) this.warn(`fileSync:${pull.key}:pull:${pull.peer}`, `File sync could not pull ${pull.key} from ${pull.peer} (${reason}); trying again in ${Math.round(delay / 1000)} s`);
    pull.retry?.cancel();
    pull.retry = this.deps.clock.setTimeout(() => {
      pull.retry = undefined;
      if (this.peer(pull.peer).present) this.schedulePull(pull.peer, pull.key);
    }, delay);
  }

  /**
   * Live consistency check (§6.2): caught up with nothing differing, yet the digests disagree under the
   * same rules — our copy of its index is wrong. One repair; if that does not help, a share error. It
   * runs on what is stored (the digest the peer paired with the maxSeq we reached) when a pull ends, when
   * a comparison has been computed in full, and on a contact that finds the pair caught up; never while
   * a pull, a repair or the comparison is still to come, since their differences are not all there yet.
   */
  liveCheck(key: string, peer: string, fromPull = false): void {
    if (this.closed) return;
    const { db, need } = this.deps;
    const share = this.deps.shares().get(key);
    if (!share || !share.spec.peers.includes(peer) || this.isExcluded(key, peer)) return;
    const pull = this.pulls.get(`${key}\n${peer}`);
    if (pull?.reset || pull?.dirty || (!fromPull && pull?.running)) return;
    if (need.comparing(key, peer)) return;
    const cursor = db.cursor(key, peer);
    if (!cursor?.indexId || !cursor.peerDigest || cursor.indexId !== cursor.peerIndexId || cursor.seq !== cursor.peerMaxSeq) return;
    if (cursor.peerRulesHash !== share.rulesHash) return;
    if (!db.shadowClean(key, peer) || need.pendingDifferences(key, peer) > 0) return;
    const summary = db.needSummary(key);
    if (summary.files || summary.blocked) return;
    const local = db.share(key);
    if (!local) return;
    const pair = `${key}\n${peer}`;
    if (local.digest === cursor.peerDigest) {
      this.repaired.delete(pair);
      this.mismatched.delete(pair);
      // The error row outlives a restart (the in-memory mark does not): any matching check clears it once no peer mismatches.
      if (!this.mismatch(key).length && db.hasError(key, "")) {
        db.writeTx(() => db.clearError(key, ""));
        this.deps.stateChanged(key);
      }
      return;
    }
    // Reported once; looking again at the same state changes nothing.
    if (this.mismatched.has(pair)) return;
    const persisted = this.repaired.has(pair);
    this.deps.emit({ event: "metric", operation: "fileSync.digestMismatch", durationMs: 0, fields: { repaired: persisted } });
    if (!persisted) {
      this.repaired.add(pair);
      this.warn(`fileSync:${key}:digest:${peer}`, `File sync found that its copy of the index of ${peer} for ${key} does not match its digest; pulling it again`);
      this.repair(key, peer, false);
      return;
    }
    this.mismatched.add(pair);
    db.writeTx(() => db.setError(key, "", "error", `${DIGEST_MISMATCH} (${peer})`, this.deps.clock.now()));
    this.warn(`fileSync:${key}:digest:${peer}`, `File sync: the index of ${peer} for ${key} still does not match its digest after a repair`);
    this.deps.stateChanged(key);
  }

  // ---- notices ----

  /** The outbox and, after a contact with notify, every share we have with the peer go out now. */
  private flush(state: PeerState, notifyAll: boolean): void {
    if (notifyAll) for (const [key] of this.sharesWith(state.id)) state.pending.add(key);
    if (state.pending.size || state.outbox.size) this.sendNotices(state);
  }

  private sendNotices(state: PeerState): void {
    if (this.closed) return;
    if (state.sending) { state.noticeTimer ??= this.deps.clock.setTimeout(() => { state.noticeTimer = undefined; this.sendNotices(state); }, this.deps.noticeDelayMs ?? NOTICE_DELAY_MS); return; }
    state.noticeTimer?.cancel();
    state.noticeTimer = undefined;
    state.outboxRetry?.cancel();
    state.outboxRetry = undefined;
    const keys = new Set([...state.outbox, ...state.pending]);
    state.pending.clear();
    state.outbox.clear();
    if (!this.noticeable(state) || !keys.size) return;
    const shares: Notice[] = [];
    const sent = new Set<string>();
    const local = this.deps.shares();
    for (const key of keys) {
      const share = local.get(key);
      const row = this.deps.db.share(key);
      if (!share || !row || !share.spec.peers.includes(state.id) || this.isExcluded(key, state.id) || state.refused.has(key)) continue;
      shares.push({ projectId: share.spec.projectId, kind: share.spec.kind, indexId: row.indexId, maxSeq: row.maxSeq, rulesHash: share.rulesHash });
      sent.add(key);
    }
    if (!shares.length) return;
    state.sending = this.track(`fileSync:peer:${state.id}`, () => this.deliver(state, shares, sent), () => { state.sending = undefined; });
  }

  private async deliver(state: PeerState, shares: Notice[], keys: Set<string>): Promise<void> {
    let fetched: Fetched | undefined;
    try {
      fetched = await this.fetch(state.id, { method: "POST", target: filesTarget("changed"), json: { shares }, purpose: "notice" }, MAX_JSON_BYTES);
    } catch { /* no answer: retried below */ }
    if (this.closed) return;
    const status = fetched?.status ?? 0;
    if (status >= 200 && status < 300) { state.outboxAttempts = 0; return; }
    if (status === 404) { this.setCapability(state, "incapable"); return; }
    // It does not share these (any more): nothing to retry, and nothing more to tell it until it names them.
    if (status === 403) { for (const key of keys) state.refused.add(key); return; }
    if (status === 400) return;
    // Its engine is off or still starting: it contacts us (and pulls) once it runs, so nothing waits here for it.
    if (status === 503 && engineNotRunning(fetched!)) { state.off = true; this.dropNotices(state); return; }
    for (const key of keys) state.outbox.add(key);
    if (!state.present) return;
    state.outboxAttempts++;
    state.outboxRetry?.cancel();
    state.outboxRetry = this.deps.clock.setTimeout(() => {
      state.outboxRetry = undefined;
      if (state.present) this.sendNotices(state);
    }, backoff(state.outboxAttempts));
  }

  // ---- lifecycle ----

  private cancelRetries(state: PeerState): void {
    state.contactRetry?.cancel();
    state.contactRetry = undefined;
    state.outboxRetry?.cancel();
    state.outboxRetry = undefined;
    for (const pull of this.pulls.values()) {
      if (pull.peer !== state.id) continue;
      pull.retry?.cancel();
      pull.retry = undefined;
    }
  }

  private forget(state: PeerState): void {
    this.cancelRetries(state);
    state.noticeTimer?.cancel();
    this.peers.delete(state.id);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const state of this.peers.values()) { this.cancelRetries(state); state.noticeTimer?.cancel(); }
    for (const pull of this.pulls.values()) pull.retry?.cancel();
    this.abort.abort();
    await this.idle();
  }
}
