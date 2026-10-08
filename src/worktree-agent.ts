import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type { AgentCapabilityIdentity } from "./agent-capabilities.js";
import { settingsDatabase } from "./settings-store.js";
import { isHarnessId, type HarnessId } from "./types.js";

const lifetime = 30 * 24 * 60 * 60 * 1000;
const hash = (token: string): string => createHash("sha256").update(token).digest("hex");

/** The caller's logical conversation plus the harness session its secrets and worktree marker use. */
export interface WorktreeAgentIdentity extends AgentCapabilityIdentity { sessionId: string }

function database(): DatabaseSync {
  const db = settingsDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS worktree_agent_tokens (
    token_hash TEXT PRIMARY KEY, project_id TEXT NOT NULL, engine TEXT NOT NULL,
    conversation_id TEXT NOT NULL, session_id TEXT NOT NULL, expires_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS worktree_agent_tokens_expiry ON worktree_agent_tokens(expires_at);`);
  return db;
}

export function worktreeAgentEnvironment(projectId: string, engine: HarnessId, conversationId: string, sessionId: string): NodeJS.ProcessEnv {
  if (!projectId || !conversationId || !sessionId) throw new Error("Worktree agent requires a project and conversation identity");
  if (!isHarnessId(engine)) throw new Error("Worktree agent requires a valid harness identity");
  const db = database();
  db.prepare("DELETE FROM worktree_agent_tokens WHERE expires_at <= ?").run(Date.now());
  const token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO worktree_agent_tokens VALUES (?, ?, ?, ?, ?, ?)").run(hash(token), projectId, engine, conversationId, sessionId, Date.now() + lifetime);
  return {
    JOINT_BOB_WORKTREE_CLI: fileURLToPath(new URL("../bin/joint-bob-worktree.mjs", import.meta.url)),
    JOINT_BOB_WORKTREE_URL: `http://127.0.0.1:${process.env.PORT || 8790}/api/worktrees/agent`,
    JOINT_BOB_WORKTREE_TOKEN: token,
  };
}

export function worktreeAgentIdentity(token: string): WorktreeAgentIdentity | undefined {
  if (!/^[a-f0-9]{64}$/.test(token)) return undefined;
  const row = database().prepare("SELECT project_id AS projectId, engine, conversation_id AS conversationId, session_id AS sessionId FROM worktree_agent_tokens WHERE token_hash=? AND expires_at>?").get(hash(token), Date.now()) as WorktreeAgentIdentity | undefined;
  return row ? { ...row } : undefined;
}

export const worktreeAgentInstructions = `# Joint Bob worktrees

A Joint Bob worktree is an isolated copy of this project's code and text. It has the project's \`.env\` files and links to its installed dependency folders (node_modules, .venv and similar), so tests and tools run there. It has no \`.git\`; its changes reach main through a GitHub pull request that Joint Bob opens for it.

node "$JOINT_BOB_WORKTREE_CLI" <command>, output is JSON:
- list: this project's worktrees with id, name, path, whether this conversation runs in it, and any pull request.
- create --name NAME [--color COLOR]: a new worktree copied from the project folder as it is now. Names are unique; list first and reuse the worktree that already handles the same issue.
- start --worktree ID --prompt TEXT | --prompt-stdin [--title TITLE]: starts a new conversation inside the worktree with the same agent and this conversation's secret accounts, and returns once it begins. The prompt must stand alone: the issue, the evidence, what done means, and to finish with the pr command.
- pr [--worktree ID] --title TITLE [--body TEXT | --body-stdin] [--base BRANCH]: commits the worktree's changes since it was created to a new branch on GitHub and opens a pull request into the default branch (main), or pushes a new commit to the open pull request it already has. Defaults to the worktree this conversation runs in. It never merges.
- delete --worktree ID: removes a worktree this conversation created. Others need the user.

One issue per worktree. For several independent issues, create one worktree and start one conversation per issue. Work inside a worktree by editing files under its path; never edit the project folder for a worktree's task. Run the project's tests in the worktree before pr. Never merge a pull request yourself; report the pull request URL. Do not read or print the capability token.

After start, the started conversation owns that issue. Do not edit its worktree, fix the same issue in the project folder, or delete the worktree; do not wait or poll for it. Report the worktree and conversation IDs and continue with other work. If tests cannot run in a worktree, say so in the pull request body instead of moving the work elsewhere. Never commit, push, stash or reset in the project folder for a worktree's task: it holds the user's uncommitted work.`;
