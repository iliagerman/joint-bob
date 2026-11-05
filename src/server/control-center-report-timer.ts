import { bobDatabase } from "../control-center/bob-store.js";
import { ensureBobScheduleSchema, nextBobWake } from "../control-center/bob-schedules.js";

/** The timer never sleeps longer than a day, so a clock that jumped is noticed. It still wakes only for a due report. */
const LONGEST_WAIT_MS = 24 * 3_600_000;

let dispatch: ((now: number) => Promise<void>) | undefined;
let timer: NodeJS.Timeout | undefined;
let generation = 0;

/**
 * One timer for all of Bob's schedules: it waits for the earliest due time, runs what is due, then waits for the next.
 * Nothing polls. A schedule saved, turned on or removed calls `rearmReportTimer` to point the timer at the new earliest time.
 */
export function startReportTimer(run: (now: number) => Promise<void>): void {
  if (dispatch) return;
  dispatch = run;
  rearmReportTimer();
}

export function rearmReportTimer(): void {
  if (!dispatch) return;
  const mine = ++generation;
  void (async () => {
    const db = await bobDatabase();
    ensureBobScheduleSchema(db);
    // A later call replaced this one while the database was opening.
    if (mine !== generation) return;
    clearTimeout(timer);
    timer = undefined;
    const next = nextBobWake(db);
    if (next === null) return;
    timer = setTimeout(() => {
      timer = undefined;
      void dispatch!(Date.now()).catch((error) => console.warn("Bob's scheduled reports failed", error instanceof Error ? error.message.slice(0, 200) : error))
        .finally(rearmReportTimer);
    }, Math.min(Math.max(next - Date.now(), 0), LONGEST_WAIT_MS));
    timer.unref();
  })().catch((error) => console.warn("Bob's report timer could not be set", error instanceof Error ? error.message.slice(0, 200) : error));
}

/** For tests: forget the timer and the dispatch function. */
export function stopReportTimer(): void {
  generation += 1;
  clearTimeout(timer);
  timer = undefined;
  dispatch = undefined;
}
