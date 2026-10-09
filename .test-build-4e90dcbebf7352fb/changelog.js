import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const semanticVersionPattern = /^\d+\.\d+\.\d+$/;
const headingPattern = /^##\s+(\d+\.\d+\.\d+)(?:\s*[—–-]\s*(.+?))?\s*$/;
const bulletPattern = /^[-*]\s+(.+?)\s*$/;
const historyLimit = 10;
function parseChangelog(source, limit = historyLimit) {
  const entries2 = [];
  for (const line of source.split("\n")) {
    const heading = headingPattern.exec(line);
    if (heading) {
      if (entries2.length === limit) break;
      entries2.push({ version: heading[1], date: heading[2] ?? null, changes: [] });
      continue;
    }
    const bullet = bulletPattern.exec(line);
    if (bullet && entries2.length) entries2[entries2.length - 1].changes.push(bullet[1]);
  }
  return entries2;
}
const manifestVersion = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8")).version;
if (!semanticVersionPattern.test(manifestVersion)) throw new Error(`package.json version is not semantic: ${manifestVersion}`);
const entries = parseChangelog(readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8"));
function appVersion() {
  return manifestVersion;
}
function readChangelog() {
  return entries;
}
export {
  appVersion,
  parseChangelog,
  readChangelog
};
