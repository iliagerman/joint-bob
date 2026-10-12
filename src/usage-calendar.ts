const formatterCache = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatterCache.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    if (formatterCache.size > 32) formatterCache.clear();
    formatterCache.set(timeZone, value);
  }
  return value;
}
export function calendarKey(instant: string, timeZone: string, hour = false): string {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(instant)).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}${hour ? `T${parts.hour}` : ''}`;
}
function partsAt(instant: number, zone: string): Record<string, string> {
  return Object.fromEntries(formatter(zone).formatToParts(new Date(instant)).map(({ type, value }) => [type, value]));
}
function offsetMinutes(instant: number, zone: string): number {
  const parts = partsAt(instant, zone);
  return (Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`) - instant) / 60_000;
}
export function calendarHourKey(instant: string, timeZone: string): string {
  const local = calendarKey(instant, timeZone, true);
  const offset = offsetMinutes(Date.parse(instant), timeZone);
  return `${local}${offset < 0 ? '-' : '+'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`;
}
function midnight(day: string, zone: string): string {
  // Solve local midnight using the offset at the candidate instant; a DST boundary
  // can change it between noon and midnight. Keep a minute-scan fallback for zones
  // whose clock jumps exactly at midnight or skips a civil day.
  const utc = Date.parse(`${day}T00:00:00Z`);
  let candidate = utc - offsetMinutes(utc + 12 * 3_600_000, zone) * 60_000;
  for (let attempt = 0; attempt < 4; attempt++) {
    candidate = utc - offsetMinutes(candidate, zone) * 60_000;
    const parts = partsAt(candidate, zone);
    if (calendarKey(new Date(candidate).toISOString(), zone, true) === `${day}T00` && parts.minute === '00') return new Date(candidate).toISOString();
  }
  for (let minute = -840; minute <= 840; minute++) {
    const instant = new Date(utc + minute * 60_000).toISOString();
    const parts = partsAt(Date.parse(instant), zone);
    if (calendarKey(instant, zone, true) === `${day}T00` && parts.minute === '00') return instant;
  }
  throw new RangeError('Invalid or skipped calendar day');
}
export function calendarBounds(from: string | undefined, to: string | undefined, zone: string): { from?: string; to?: string } {
  formatter(zone);
  const next = to ? new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : undefined;
  return { from: from ? midnight(from, zone) : undefined, to: next ? midnight(next, zone) : undefined };
}
