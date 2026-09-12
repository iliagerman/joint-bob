import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { resolveDataDirectory } from "./data-directory.js";

type BrowserAgentIdentity = { projectId: string; engine: "pi" | "claude"; conversationId: string };
const lifetime = 30 * 24 * 60 * 60 * 1000;
let database: DatabaseSync | undefined;

function db(): DatabaseSync {
  if (!database) {
    const directory = resolveDataDirectory();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    database = new DatabaseSync(path.join(directory, "node.db"));
    database.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS browser_agent_tokens (
        token_hash TEXT PRIMARY KEY, project_id TEXT NOT NULL,
        engine TEXT NOT NULL CHECK (engine IN ('pi', 'claude')),
        conversation_id TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS browser_agent_tokens_expiry ON browser_agent_tokens(expires_at);`);
  }
  database.prepare("DELETE FROM browser_agent_tokens WHERE expires_at <= ?").run(Date.now());
  return database;
}

function hash(token: string): string { return createHash("sha256").update(token).digest("hex"); }

/** Call once when composing an agent environment, not once per shell command. */
export function browserAgentEnvironment(projectId: string, engine: "pi" | "claude", conversationId: string): NodeJS.ProcessEnv {
  if (!projectId || !conversationId) throw new Error("Browser agent requires a project and conversation identity");
  const token = randomBytes(32).toString("hex");
  db().prepare("INSERT INTO browser_agent_tokens (token_hash, project_id, engine, conversation_id, expires_at) VALUES (?, ?, ?, ?, ?)")
    .run(hash(token), projectId, engine, conversationId, Date.now() + lifetime);
  return {
    JOINT_BOB_BROWSER_URL: `http://127.0.0.1:${process.env.PORT || 8790}/api/browser/agent`,
    JOINT_BOB_BROWSER_TOKEN: token,
    // Both src/ and installed dist/ are siblings of bin/.
    JOINT_BOB_BROWSER_CLI: fileURLToPath(new URL("../bin/joint-bob-browser.mjs", import.meta.url)),
  };
}

export function browserAgentIdentity(token: string): BrowserAgentIdentity | undefined {
  if (!/^[a-f0-9]{64}$/.test(token)) return undefined;
  const row = db().prepare("SELECT project_id AS projectId, engine, conversation_id AS conversationId FROM browser_agent_tokens WHERE token_hash = ? AND expires_at > ?")
    .get(hash(token), Date.now()) as BrowserAgentIdentity | undefined;
  return row ? { ...row } : undefined;
}

export const browserAgentInstructions = `# Joint Bob browser

Ordinary website browsing, real-account sign-in, and live-site checks must use the designated browser executor through:
node "$JOINT_BOB_BROWSER_CLI" <command>
For those activities, do not launch local Chrome, Playwright browsers, or another browser tool. If executor startup is disabled or the designated executor is offline, report the error and stop. There is no local fallback for those activities. This controls browser pages, not an OS desktop.

Repository test exception: Native Chrome/Playwright launches are allowed only for this project's automated tests run through its documented, isolated test harness. Read TESTING.md first. Verify disposable HOME/data directories, synthetic test accounts, loopback fixture servers, and cleanup of test-owned browsers. Never use real credentials, production data, existing user/browser profiles, or this exception for manual/live-site browsing or to bypass human takeover. Executor-specific tests still use the supplied CLI. If isolation cannot be verified, stop.

Start explicitly with start [url] [--profile ID]. Commands target this conversation's running browser; do not supply another project or session identity. Use status, tabs, profiles, navigate URL, snapshot, click SELECTOR, fill SELECTOR TEXT, evaluate EXPRESSION, close, or save-login LABEL. Use command '{"action":"..."}' for other browser commands. Run interactive test assertions through evaluate and read the returned results; do not claim tests passed without checking them. Manual takeover pauses agent commands. Wait for the user to resume agent control; do not override takeover.

For attached credentials use fill-secret SELECTOR ENV_NAME --origin URL. Pass only the variable name, never its expanded value. The CLI checks the current active page's exact origin before filling. Do not print credentials, browser tokens, cookies, or secret field contents through evaluate, snapshots, logs, or shell tracing. Do not inspect the browser token environment variable.

Use screenshot PATH to save an image, upload SELECTOR FILE... for local files or directories (20 MiB total), and download ID PATH for downloaded bytes. Screenshots and downloads are written on the agent node, with parent directories created. Do not dump image or file base64 into the conversation.
`;
