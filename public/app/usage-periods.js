// Calendar periods in the viewer's local time. Day keys match the API's local day buckets.

const pad = (value) => String(value).padStart(2, "0");
export const isoDate = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const day = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const addDays = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
const daysInMonth = (year, month) => new Date(year, month + 1, 0).getDate();

/** First day of the week for the viewer's locale, as Date#getDay numbers it (0 is Sunday). */
export function localeWeekStart(language = globalThis.navigator?.language) {
  try {
    const locale = new Intl.Locale(language || "en");
    const info = locale.getWeekInfo?.() ?? locale.weekInfo;
    return info?.firstDay ? info.firstDay % 7 : 1;
  } catch { return 1; }
}

/** Date filters for a period preset; "all" has neither bound. */
export function presetRange(preset, today = new Date()) {
  const now = day(today);
  if (preset === "last-month") return { from: isoDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: isoDate(new Date(now.getFullYear(), now.getMonth(), 0)) };
  if (preset === "30d") return { from: isoDate(addDays(now, -29)), to: isoDate(now) };
  if (preset === "90d") return { from: isoDate(addDays(now, -89)), to: isoDate(now) };
  if (preset === "all") return { from: "", to: "" };
  return { from: isoDate(new Date(now.getFullYear(), now.getMonth(), 1)), to: isoDate(now) };
}

/** The current period and the `count - 1` before it, newest first. */
export function periodWindows(kind, today = new Date(), weekStart = 1, count = 4) {
  const now = day(today);
  return Array.from({ length: count }, (_, index) => {
    if (kind === "month") {
      const start = new Date(now.getFullYear(), now.getMonth() - index, 1);
      return { start, length: daysInMonth(start.getFullYear(), start.getMonth()) };
    }
    const current = addDays(now, -((now.getDay() - weekStart + 7) % 7));
    return { start: addDays(current, -7 * index), length: 7 };
  });
}

const costOf = (totals) => Number.isFinite(totals?.apiCostUsd) ? totals.apiCostUsd : 0;

/**
 * Cumulative known cost per day for this period and the previous ones. `toDate` compares
 * like with like: each earlier period summed through the same day the current one has reached.
 */
export function comparePeriods(dayRows, kind, today = new Date(), weekStart = 1, count = 4) {
  const byDay = new Map(dayRows.map((row) => [row.key, row.totals]));
  const windows = periodWindows(kind, today, weekStart, count);
  const elapsed = Math.round((day(today) - windows[0].start) / 86_400_000) + 1;
  const periods = windows.map(({ start, length }, index) => {
    let running = 0;
    const days = Array.from({ length }, (_, offset) => {
      const date = addDays(start, offset);
      const totals = byDay.get(isoDate(date));
      running += costOf(totals);
      return { date, key: isoDate(date), cost: costOf(totals), cumulative: running, partial: Boolean(totals?.partial) };
    });
    const reached = Math.min(elapsed, length);
    return {
      index, start, length, days,
      end: days.at(-1).date,
      reached,
      toDate: days[reached - 1].cumulative,
      total: index ? running : days[reached - 1].cumulative,
      partial: days.slice(0, reached).some((item) => item.partial),
    };
  });
  const previous = periods.slice(1);
  const average = previous.length ? previous.reduce((sum, item) => sum + item.toDate, 0) / previous.length : 0;
  return { kind, elapsed, periods, average };
}

/** Relative change, or null when there is nothing to compare against. */
export function change(current, baseline) {
  return baseline > 0 ? (current - baseline) / baseline : null;
}
