import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";

const MAX_BYTES = 200_000;
const MAX_FILES = 40;

export interface SkillContents {
  /** The folder the skill was loaded from. */
  path: string;
  content: string;
  truncated: boolean;
  bytes: number;
  lines: number;
  modifiedAt: string;
  /** Names of the other files beside SKILL.md, which the skill may read when it runs. */
  files: string[];
}

/** Reads a skill's SKILL.md and lists what sits beside it. The folder comes from the node's own skill inventory. */
export async function readSkillContents(folder: string): Promise<SkillContents> {
  const file = path.join(folder, "SKILL.md");
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    const buffer = Buffer.alloc(Math.min(info.size, MAX_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const content = buffer.subarray(0, bytesRead).toString("utf8");
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    const files = entries.filter((entry) => entry.name !== "SKILL.md" && !entry.name.startsWith(".")).slice(0, MAX_FILES)
      .map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name).sort();
    return { path: folder, content, truncated: info.size > MAX_BYTES, bytes: info.size, lines: content ? content.split("\n").length : 0, modifiedAt: (await stat(file)).mtime.toISOString(), files };
  } finally { await handle.close(); }
}
