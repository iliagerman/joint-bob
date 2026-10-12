import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { usageDatabase } from './usage-ledger.js';

export const draftInput = z.object({ projectId: z.string().min(1).max(200), name: z.string().regex(/^[a-z][a-z0-9-]{1,59}$/), kind: z.enum(['skill', 'script']), content: z.string().min(20).max(10000), evidenceConversationIds: z.array(z.string().min(1).max(300)).min(3).max(10).refine((ids) => new Set(ids).size === ids.length, 'Evidence conversations must be distinct') }).strict();
export const draftApproval = z.object({ approved: z.literal(true), reviewedSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type DraftInput = z.infer<typeof draftInput>;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function database() {
  const db = usageDatabase();
  db.exec('CREATE TABLE IF NOT EXISTS usage_skill_drafts(id TEXT PRIMARY KEY,owner TEXT NOT NULL,project_id TEXT NOT NULL,payload TEXT NOT NULL,installed_at TEXT)');
  return db;
}
export function createUsageDraft(owner: string, input: DraftInput) {
  const value = draftInput.parse(input);
  const id = randomUUID();
  const reviewedSha256 = digest(value.content);
  database().prepare('INSERT INTO usage_skill_drafts(id,owner,project_id,payload) VALUES(?,?,?,?)').run(id, owner, value.projectId, JSON.stringify(value));
  return { id, ...value, reviewedSha256, status: 'draft' };
}
export function getUsageDraft(owner: string, id: string): (DraftInput & { id: string; reviewedSha256: string; status: string }) | null {
  const row = database().prepare('SELECT payload,installed_at FROM usage_skill_drafts WHERE id=? AND owner=?').get(id, owner) as { payload: string; installed_at: string | null } | undefined;
  if (!row) return null;
  const payload = draftInput.parse(JSON.parse(row.payload));
  return { ...payload, id, reviewedSha256: digest(payload.content), status: row.installed_at ? 'installed' : 'draft' };
}
async function safeDirectory(root: string, components: string[]) {
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    try { await mkdir(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Draft destination must be a real directory');
  }
  return current;
}
/** Approval can only add a new file. No overwrite, execution, sharing, or symlink traversal. */
export async function installUsageDraft(owner: string, id: string, reviewedSha256: string, projectPath: string) {
  const draft = getUsageDraft(owner, id);
  if (!draft) return null;
  if (draft.status !== 'draft') throw new Error('Draft was already installed');
  if (draft.reviewedSha256 !== reviewedSha256) throw new Error('Draft changed since review');
  const directory = await safeDirectory(projectPath, draft.kind === 'skill' ? ['.agents', 'skills', draft.name] : ['scripts', 'usage']);
  const destination = path.join(directory, draft.kind === 'skill' ? 'SKILL.md' : `${draft.name}.sh`);
  const content = draft.kind === 'skill' ? `---\nname: ${draft.name}\ndescription: User-reviewed skill draft\n---\n\n${draft.content}\n` : `#!/bin/sh\nset -eu\n${draft.content}\n`;
  const file = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(content); } finally { await file.close(); }
  database().prepare('UPDATE usage_skill_drafts SET installed_at=? WHERE id=? AND owner=? AND installed_at IS NULL').run(new Date().toISOString(), id, owner);
  return { id, projectId: draft.projectId, kind: draft.kind, name: draft.name, status: 'installed', path: destination };
}
