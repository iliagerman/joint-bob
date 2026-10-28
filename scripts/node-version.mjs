import path from "node:path";
import { pathToFileURL } from "node:url";

export function nodeVersionAtLeast(version, minimum) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
    if (!match) return undefined;
    const parts = match.slice(1).map(Number);
    return parts.every(Number.isSafeInteger) ? parts : undefined;
  };
  const actual = parse(version);
  const required = parse(minimum);
  if (!actual || !required) return false;
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] > required[index]) return true;
    if (actual[index] < required[index]) return false;
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const minimum = process.argv[2];
  process.exit(nodeVersionAtLeast(process.versions.node, minimum) ? 0 : 1);
}
