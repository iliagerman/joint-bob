export const REMOVED = "[removed by Guardian]";

// Formats with a recognisable shape. Values that look like any other string are only found
// when they are one of the project's own secrets, which are matched exactly.
const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];
// KEY=value and "password": "value" pairs whose name says what they are. The name stays.
const NAMED = /\b([A-Za-z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE_KEY)[A-Za-z0-9_]*)(["']?\s*[=:]\s*)(["']?)[^\s"'`]{6,}\3/gi;

/** Removes known secret values and common credential formats from text. */
export function removeSecrets(text: string, knownSecrets: string[]): string {
  let result = text;
  // Longest first, so a secret that contains another is removed whole.
  for (const secret of [...new Set(knownSecrets)].filter((value) => value.length >= 8).sort((left, right) => right.length - left.length)) {
    result = result.split(secret).join(REMOVED);
  }
  for (const pattern of PATTERNS) result = result.replace(pattern, REMOVED);
  return result.replace(NAMED, (_match, name: string, separator: string, quote: string) => `${name}${separator}${quote}${REMOVED}${quote}`);
}

/** The same removal over every string inside a tool call's arguments. */
export function removeSecretsFromValue(value: unknown, knownSecrets: string[]): unknown {
  if (typeof value === "string") return removeSecrets(value, knownSecrets);
  if (Array.isArray(value)) return value.map((item) => removeSecretsFromValue(item, knownSecrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, removeSecretsFromValue(item, knownSecrets)]));
  return value;
}
