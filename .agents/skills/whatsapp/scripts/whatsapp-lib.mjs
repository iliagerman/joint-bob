const activityPattern = /^(?:\d{1,2}:\d{2}|Yesterday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|\d{1,2}\/\d{1,2}\/\d{4})$/;
const weekdays = new Map(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((name, index) => [name, index]));

function utcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function parseChatRows(rawRows) {
  return rawRows.flatMap(raw => {
    const lines = raw.split("\n").map(value => value.trim()).filter(Boolean);
    const activityIndex = lines.findIndex(value => activityPattern.test(value));
    if (activityIndex < 0) return [];
    let name = lines[activityIndex - 1] ?? "";
    if (activityIndex === 1 && /unread messages?$/.test(lines[activityIndex + 1] ?? "")) name = lines[activityIndex + 2] ?? name;
    return name ? [{ name, activity: lines[activityIndex] }] : [];
  });
}

export function parseActivityLabel(label, now = new Date()) {
  const today = utcDay(now);
  if (/^\d{1,2}:\d{2}$/.test(label)) return today;
  if (label === "Yesterday") return new Date(today.getTime() - 86_400_000);
  if (weekdays.has(label)) {
    let days = (today.getUTCDay() - weekdays.get(label)) % 7;
    if (days <= 0) days += 7;
    return new Date(today.getTime() - days * 86_400_000);
  }
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(label);
  if (!match) throw new Error(`Unknown WhatsApp activity label: ${label}`);
  return new Date(Date.UTC(Number(match[3]), Number(match[1]) - 1, Number(match[2])));
}

export function redactSensitive(text) {
  return text
    .replace(/((?:pass(?:word)?|2fa|otp|one[- ]time code|security code|token|secret|api[_ -]?key)\s*[:=]\s*)[^\n]+/gi, "$1[REDACTED]")
    .replace(/\b(?:[A-Z0-9]{4}[ -]){5,}[A-Z0-9]{4}\b/g, "[REDACTED CREDENTIAL]");
}

export function latestActiveGroups(rows, days = 30, now = new Date()) {
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error("Days must be an integer from 1 to 366");
  const cutoff = utcDay(now).getTime() - days * 86_400_000;
  const latest = new Map();
  for (const row of rows) {
    const date = parseActivityLabel(row.activity, now);
    const existing = latest.get(row.name);
    if (!existing || date > existing.date) latest.set(row.name, { ...row, date });
  }
  return [...latest.values()]
    .filter(row => row.date.getTime() >= cutoff)
    .sort((a, b) => b.date - a.date || a.name.localeCompare(b.name))
    .map(row => ({ name: row.name, activity: row.activity, date: row.date.toISOString().slice(0, 10) }));
}
