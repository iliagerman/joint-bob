import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveLocalSessionPath, sessionCwds } from "../src/session-paths.js";

// Settings read their data directory once, at module load, so the override has
// to be in place before the settings-backed modules below are imported.
const settingsRoot = mkdtempSync(path.join(os.tmpdir(), "joint-bob-session-paths-"));
process.env.PI_WEB_DATA_DIR = settingsRoot;

const settings = await import("../src/settings.js");
const claude = await import("../src/claude-service.js");
const watcher = await import("../src/watcher.js");

after(() => rm(settingsRoot, { recursive: true, force: true }));

function useClaudeProjectsRoot(name: string): string {
  const projectsRoot = path.join(settingsRoot, name, "projects");
  settings.updateSettings({
    pi: { executable: "pi", configPath: path.join(settingsRoot, "pi-config"), sessionPath: path.join(settingsRoot, "pi-sessions") },
    claude: { executable: "claude", configPath: path.join(settingsRoot, name), sessionPath: projectsRoot },
    syncthing: { endpoint: "" },
  });
  return projectsRoot;
}

test("resolveLocalSessionPath maps synchronized Pi conversations into the destination home", () => {
  assert.deepEqual(
    resolveLocalSessionPath("/Users/a/.pi/agent/sessions/x.jsonl", "/home/b"),
    { engine: "pi", path: "/home/b/.pi/agent/sessions/x.jsonl" },
  );
  assert.deepEqual(
    resolveLocalSessionPath("/Users/a/.pi/old/.pi/agent/sessions/x.jsonl", "/home/b"),
    { engine: "pi", path: "/home/b/.pi/agent/sessions/x.jsonl" },
  );
});

test("resolveLocalSessionPath rejects paths outside synchronized roots and traversal", () => {
  assert.throws(() => resolveLocalSessionPath("/Users/a/project/session.jsonl", "/home/b"), /outside/i);
  assert.throws(() => resolveLocalSessionPath("/Users/a/.pi/agent/../session.jsonl", "/home/b"), /invalid/i);
});

// The takeover wire format only swaps the home prefix, so it keeps the encoded
// project directory of whichever node started the conversation. That name is
// transport, not the path a turn resumes from: the local path is re-derived
// from this node's own cwd before the turn runs.
test("a synchronized Claude path keeps the sender's encoded directory, and the local path is re-derived from this node's cwd", async () => {
  assert.deepEqual(
    resolveLocalSessionPath("claude:/Users/a/.claude/projects/-Users-a-project/session.jsonl", "/home/b"),
    { engine: "claude", path: "claude:/home/b/.claude/projects/-Users-a-project/session.jsonl" },
  );

  const projectsRoot = useClaudeProjectsRoot("resumed");

  assert.equal(
    claude.claudeSessionFilePath("/home/b/project", "session"),
    path.join(projectsRoot, "-home-b-project", "session.jsonl"),
  );
});

// The watcher used to omit the projects root and silently fall back to
// ~/.claude/projects, so a node with a relocated Claude config watched nothing.
test("the session watcher honours a relocated Claude projects root", () => {
  const projectsRoot = useClaudeProjectsRoot("relocated");

  const dirs = watcher.sessionWatchDirs({ path: "/srv/projects/internal-assistant" });

  assert.ok(dirs.includes(path.join(projectsRoot, "-srv-projects-internal-assistant")), dirs.join(", "));
  assert.deepEqual(dirs.filter((dir: string) => dir.startsWith(path.join(os.homedir(), ".claude"))), []);
});

test("sessionCwds returns both project paths", () => {
  const paths = sessionCwds({
    path: "/srv/projects/internal-assistant",
    macPath: "/Users/example/Projects/internal-assistant",
  });

  assert.deepEqual(paths, [
    "/srv/projects/internal-assistant",
    "/Users/example/Projects/internal-assistant",
  ]);
});

test("sessionCwds is direction-neutral", () => {
  const forward = sessionCwds({ path: "/server/project", macPath: "/mac/project" });
  const reverse = sessionCwds({ path: "/mac/project", macPath: "/server/project" });

  assert.deepEqual(new Set(reverse), new Set(forward));
});

test("sessionCwds normalizes and deduplicates paths", () => {
  const paths = sessionCwds({ path: "/server/work/../project", macPath: "/server/project" });

  assert.deepEqual(paths, ["/server/project"]);
});

test("sessionCwds includes paths learned from any number of nodes", () => {
  assert.deepEqual(
    sessionCwds({
      path: "/node-b/project",
      locations: [
        { nodeId: "node-a", path: "/node-a/project" },
        { nodeId: "node-c", path: "/node-c/project" },
      ],
    }),
    ["/node-b/project", "/node-a/project", "/node-c/project"],
  );
});

test("sessionCwds includes ticket worktrees", () => {
  assert.deepEqual(
    sessionCwds({ path: "/server/project", additionalPaths: ["/server/worktrees/ticket-one"] }),
    ["/server/project", "/server/worktrees/ticket-one"],
  );
});

test("sessionCwds supports projects without a paired path", () => {
  assert.deepEqual(sessionCwds({ path: "/server/project" }), ["/server/project"]);
});

test("one stale cross-node session alias does not hide valid sessions", async () => {
  const source = await readFile("src/pi-service.ts", "utf8");

  assert.match(source, /Could not list Pi sessions for/);
  assert.match(source, /return \[\];/);
});
