// Reads days, times and lengths out of a request in code, so no model ever calculates a date.
// Anything this cannot read is reported as missing and the caller is asked for it.

export interface MeetingRequest {
  /** Calendar day in the owner's time zone, as YYYY-MM-DD. */
  day?: string;
  /** Minutes after midnight on that day. */
  minute?: number;
  partOfDay?: "morning" | "afternoon" | "evening";
  durationMinutes?: number;
  title?: string;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_ALIASES: Record<string, number> = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/** Full names and exact abbreviations only, so "decide 2" is not 2 December. */
const MONTH_PATTERN = [...MONTH_NAMES, ...MONTHS, "sept"].sort((left, right) => right.length - left.length).join("|");
const monthNumber = (word: string) => (word === "sept" ? 9 : (MONTH_NAMES.indexOf(word) + 1 || MONTHS.indexOf(word) + 1));
/** A real calendar date, never a rolled-over one like 31 February. */
function realDay(year: number, month: number, date: number): string | undefined {
  const moved = new Date(Date.UTC(year, month - 1, date));
  return moved.getUTCFullYear() === year && moved.getUTCMonth() === month - 1 && moved.getUTCDate() === date ? dayKey(year, month, date) : undefined;
}
export const PART_OF_DAY: Record<NonNullable<MeetingRequest["partOfDay"]>, [number, number]> = { morning: [9 * 60, 12 * 60], afternoon: [12 * 60, 17 * 60], evening: [17 * 60, 20 * 60] };

/** Wall-clock parts of an instant in a time zone. */
export function zonedParts(instant: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "long", hourCycle: "h23" })
    .formatToParts(instant).map(part => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), weekday: WEEKDAYS.indexOf(String(parts.weekday).toLowerCase()) };
}

/** The instant a wall-clock time in a time zone denotes. */
export function zonedInstant(day: string, minuteOfDay: number, timeZone: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  const wanted = Date.UTC(year, month - 1, date, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  let guess = wanted;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = zonedParts(new Date(guess), timeZone);
    const shown = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    if (shown === wanted) break;
    guess += wanted - shown;
  }
  return new Date(guess);
}

export function dayKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
export function addDays(day: string, count: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const moved = new Date(Date.UTC(year, month - 1, date + count));
  return dayKey(moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate());
}
function weekdayOf(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date)).getUTCDay();
}

function parseDay(text: string, today: string): string | undefined {
  if (/\btoday\b/.test(text)) return today;
  if (/\btomorrow\b/.test(text)) return addDays(today, 1);
  const iso = /\b(20\d\d)-(\d\d)-(\d\d)\b/.exec(text);
  if (iso) return realDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const dayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_PATTERN})\\b`).exec(text);
  const monthFirst = new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(text);
  const named = dayFirst ? { date: Number(dayFirst[1]), month: monthNumber(dayFirst[2]) } : monthFirst ? { date: Number(monthFirst[2]), month: monthNumber(monthFirst[1]) } : undefined;
  if (named) {
    const year = Number(today.slice(0, 4));
    const candidate = realDay(year, named.month, named.date);
    if (!candidate) return undefined;
    return candidate < today ? realDay(year + 1, named.month, named.date) : candidate;
  }
  const weekday = new RegExp(`\\b(next\\s+)?(${[...WEEKDAYS, ...Object.keys(WEEKDAY_ALIASES)].join("|")})\\b`).exec(text);
  if (weekday) {
    const target = WEEKDAYS.includes(weekday[2]) ? WEEKDAYS.indexOf(weekday[2]) : WEEKDAY_ALIASES[weekday[2]];
    let ahead = (target - weekdayOf(today) + 7) % 7 || 7;
    if (weekday[1] && ahead < 7 && /\bnext\s+week\b/.test(text)) ahead += 7;
    return addDays(today, ahead);
  }
  return undefined;
}

function parseTime(text: string): number | undefined {
  const meridiem = /\b(\d{1,2})(?::(\d{2}))?\s*(am\b|pm\b|a\.m\.|p\.m\.)/.exec(text);
  if (meridiem) {
    let hour = Number(meridiem[1]) % 12;
    if (meridiem[3].startsWith("p")) hour += 12;
    const minute = Number(meridiem[2] ?? 0);
    return hour < 24 && minute < 60 ? hour * 60 + minute : undefined;
  }
  const clock = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/.exec(text);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  const bare = /\bat\s+(\d{1,2})\b(?!\s*(?:minutes?|mins?|hours?|hrs?|nov|dec|jan|feb|mar|apr|may|jun|jul|aug|sep|oct))/.exec(text);
  if (bare) {
    const hour = Number(bare[1]);
    if (hour >= 8 && hour <= 23) return hour * 60;
    if (hour >= 1 && hour <= 7) return (hour + 12) * 60;
  }
  if (/\bnoon\b/.test(text)) return 12 * 60;
  return undefined;
}

function parseDuration(text: string): number | undefined {
  if (/\bhalf\s+an?\s+hour\b|\bhalf-hour\b|\bhalf\s+hour\b/.test(text)) return 30;
  if (/\bquarter\s+of\s+an\s+hour\b/.test(text)) return 15;
  const minutes = /\b(\d{1,3})[\s-]*(?:minutes?|mins?)\b/.exec(text);
  if (minutes) return Number(minutes[1]);
  const hours = /\b(\d+(?:\.\d+)?)[\s-]*(?:hours?|hrs?)\b/.exec(text);
  if (hours) return Math.round(Number(hours[1]) * 60);
  if (/\ban\s+hour\b/.test(text)) return 60;
  return undefined;
}

function parseTitle(original: string): string | undefined {
  const pattern = /\b(?:for|about|to discuss)\s+(?:the|a|an|our)?\s*([^?.!,;]+?)(?=\s+(?:on|at|next|this|tomorrow|today|for)\b|[?.!,;]|$)/gi;
  for (const match of original.matchAll(pattern)) {
    const title = match[1]?.trim();
    if (!title || /^\d/.test(title) || /^(minutes?|mins?|hours?|an?\s+hour|half|quarter|a\s+(?:few|couple))\b/i.test(title)) continue;
    return (title[0].toUpperCase() + title.slice(1)).slice(0, 80);
  }
  return undefined;
}

/** What a meeting or availability request says, relative to today in the owner's time zone. */
export function parseMeetingRequest(original: string, reference: Date, timeZone: string): MeetingRequest {
  const text = original.toLowerCase();
  const parts = zonedParts(reference, timeZone);
  const today = dayKey(parts.year, parts.month, parts.day);
  const partOfDay = /\bmorning\b/.test(text) ? "morning" : /\bafternoon\b/.test(text) ? "afternoon" : /\bevening\b/.test(text) ? "evening" : undefined;
  return { day: parseDay(text, today), minute: parseTime(text), partOfDay, durationMinutes: parseDuration(text), title: parseTitle(original) };
}

/** "Thu 5 Nov, 15:00–15:30", in the owner's time zone. */
export function describeSlot(start: Date, end: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" }).format(start);
  const time = (instant: Date) => new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(instant);
  return `${day}, ${time(start)}–${time(end)}`;
}
