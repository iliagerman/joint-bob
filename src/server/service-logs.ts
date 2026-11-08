import { open, stat, truncate, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * On a Mac, launchd appends the server's output to logs/node.log and logs/node.error.log, and
 * nothing ever trimmed them (node.error.log reached 240 MB). launchd keeps them open in append
 * mode, so a renamed file would keep growing; instead, a log past the limit keeps its newest
 * part in `<name>.1` and is truncated in place, and launchd's next write lands at its start.
 * Linux nodes log to the journal, which has its own limits; there these files do not exist.
 */
const LOG_NAMES = ["node.log", "node.error.log"];
const LIMIT_BYTES = 50 * 1024 * 1024;
const KEEP_BYTES = 10 * 1024 * 1024;

export async function trimServiceLogs(directory: string, limit = LIMIT_BYTES, keep = KEEP_BYTES): Promise<string[]> {
  const trimmed: string[] = [];
  for (const name of LOG_NAMES) {
    const file = path.join(directory, name);
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile() || info.size <= limit) continue;
    const handle = await open(file, "r");
    try {
      const length = Math.min(keep, info.size);
      const tail = Buffer.alloc(length);
      await handle.read(tail, 0, length, info.size - length);
      // Start at a whole line, so the kept part does not begin mid-message.
      const firstLine = tail.indexOf(10);
      await writeFile(`${file}.1`, firstLine >= 0 && firstLine < length - 1 ? tail.subarray(firstLine + 1) : tail, { mode: 0o600 });
    } finally {
      await handle.close();
    }
    await truncate(file, 0);
    trimmed.push(name);
  }
  return trimmed;
}
