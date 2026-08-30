import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** One released version and the changes that shipped in it. */
export interface ChangelogEntry {
  version: string;
  date: string | null;
  changes: string[];
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const semanticVersionPattern = /^\d+\.\d+\.\d+$/;
const headingPattern = /^##\s+(\d+\.\d+\.\d+)(?:\s*[—–-]\s*(.+?))?\s*$/;
const bulletPattern = /^[-*]\s+(.+?)\s*$/;
// The dialog and the settings list both show the same window of history.
const historyLimit = 10;

/**
 * Parses the `## <version> — <date>` sections of a changelog, newest first.
 * Anything that is not a version heading or a bullet is layout and is ignored.
 */
export function parseChangelog(source: string, limit = historyLimit): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  for (const line of source.split("\n")) {
    const heading = headingPattern.exec(line);
    if (heading) {
      if (entries.length === limit) break;
      entries.push({ version: heading[1], date: heading[2] ?? null, changes: [] });
      continue;
    }
    const bullet = bulletPattern.exec(line);
    if (bullet && entries.length) entries[entries.length - 1].changes.push(bullet[1]);
  }
  return entries;
}

// Neither file can change while the process runs: an update replaces the
// installation directory and restarts the service.
const manifestVersion = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8")).version;
if (!semanticVersionPattern.test(manifestVersion)) throw new Error(`package.json version is not semantic: ${manifestVersion}`);
const entries = parseChangelog(readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8"));

/** The running deployment's semantic version. package.json is the only source of truth. */
export function appVersion(): string {
  return manifestVersion;
}

/** The ten most recent released versions, newest first. */
export function readChangelog(): ChangelogEntry[] {
  return entries;
}
