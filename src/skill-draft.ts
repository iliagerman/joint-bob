import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import { z } from "zod";

export const skillDraftSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{1,59}$/),
  description: z.string().trim().min(1).max(1000),
  instructions: z.string().trim().min(20).max(20000),
}).strict();

/** Only an explicit save creates a file; never overwrite or follow a linked destination. */
export async function saveSkillDraft(root: string, folders: string[], input: z.infer<typeof skillDraftSchema>): Promise<string> {
  const draft = skillDraftSchema.parse(input);
  let directory = root;
  for (const folder of [...folders, draft.name]) {
    directory = path.join(directory, folder);
    try { await mkdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Skill destination must be a real directory");
  }
  const destination = path.join(directory, "SKILL.md");
  const file = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(`---\n${stringify({ name: draft.name, description: draft.description })}---\n\n${draft.instructions}\n`);
  } finally { await file.close(); }
  return destination;
}
