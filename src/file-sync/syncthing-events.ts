import { systemClock, type Clock } from "./types.js";

/* auto-transition: Syncthing's event stream, so a change made outside Joint Bob (the Syncthing GUI
   or CLI, a restored configuration) is noticed when it happens. A long poll of /rest/events: each
   request waits in Syncthing until an event arrives, so nothing here runs on a timer except one
   retry after Syncthing did not answer, with the switch's backoff. A node without Syncthing set up
   subscribes to nothing until its connection is set again (restart()). */

export interface StreamEvent { id: number; type: string; data?: unknown }

export interface EventSource {
  /** Events of `types` after `since`, waiting up to `timeoutSeconds`; `limit` keeps the newest. */
  events(options: { since: number; types: readonly string[]; timeoutSeconds: number; limit?: number; signal: AbortSignal }): Promise<StreamEvent[]>;
  /** Syncthing is not set up on this node: there is nothing to subscribe to. */
  notConfigured(error: unknown): boolean;
}

export interface EventStreamOptions {
  source: EventSource;
  types: readonly string[];
  /** Events as they arrive, in order. */
  onEvents: (events: StreamEvent[]) => void;
  /** Subscribed again (first time, after a failure, a new connection): what changed meanwhile went unseen. */
  onSubscribed: () => void;
  /** Syncthing did not answer (once per failure streak). */
  onFailure?: (error: unknown) => void;
  clock?: Clock;
  retry?: { minMs: number; maxMs: number };
  timeoutSeconds?: number;
}

const RETRY = { minMs: 5_000, maxMs: 5 * 60_000 };
const TIMEOUT_SECONDS = 60;

export class SyncthingEventStream {
  private generation = 0;
  private controller?: AbortController;
  private timer?: { cancel(): void };
  private attempts = 0;
  private stopped = false;
  /** Tests: the poll in flight settles. */
  running?: Promise<void>;

  constructor(private readonly options: EventStreamOptions) {}

  start(): void { if (!this.stopped) this.begin(); }

  /** Pointed at another Syncthing (or set up now): subscribe again from its newest event. */
  restart(): void {
    if (this.stopped) return;
    this.attempts = 0;
    this.begin();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    this.controller?.abort();
    this.timer?.cancel();
  }

  private begin(): void {
    const generation = ++this.generation;
    this.controller?.abort();
    this.timer?.cancel();
    this.timer = undefined;
    const controller = new AbortController();
    this.controller = controller;
    this.running = this.run(generation, controller.signal);
  }

  private async run(generation: number, signal: AbortSignal): Promise<void> {
    const { source, types } = this.options;
    const current = () => generation === this.generation && !this.stopped;
    try {
      // The newest event's id: what happened before it is covered by the check onSubscribed runs.
      const [latest] = await source.events({ since: 0, types, timeoutSeconds: 0, limit: 1, signal });
      if (!current()) return;
      let since = latest?.id ?? 0;
      this.attempts = 0;
      this.options.onSubscribed();
      while (current()) {
        const events = await source.events({ since, types, timeoutSeconds: this.options.timeoutSeconds ?? TIMEOUT_SECONDS, signal });
        if (!current()) return;
        const fresh = events.filter((event) => event.id > since);
        if (!fresh.length) continue;
        since = Math.max(...fresh.map((event) => event.id));
        this.options.onEvents(fresh);
      }
    } catch (error) {
      if (!current()) return;
      // Nothing to listen to here; restart() subscribes once Syncthing is set up.
      if (source.notConfigured(error)) return;
      if (this.attempts++ === 0) this.options.onFailure?.(error);
      const retry = this.options.retry ?? RETRY;
      const delay = Math.min(retry.maxMs, retry.minMs * 2 ** (this.attempts - 1));
      this.timer = (this.options.clock ?? systemClock).setTimeout(() => { this.timer = undefined; if (current()) this.begin(); }, delay);
    }
  }
}

/** The events that can put a Syncthing folder over a project's files, or let a waiting move go on. */
export const SYNCTHING_EVENT_TYPES = ["ConfigSaved", "FolderPaused", "FolderResumed", "StateChanged", "FolderCompletion"] as const;
