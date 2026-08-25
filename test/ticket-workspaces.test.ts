import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureManagedHome, managedProjectPath, managedTypeRoot } from "../src/managed-home.js";
import {
  assertTaskWorkspaceReady,
  createTaskWorkspace,
  expectedTaskWorkspacePath,
  removeTaskWorkspace,
  TICKET_WORKSPACE_FOLDER_ID,
} from "../src/task-workspaces.js";

async function missing(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

test("managed homes ignore projects and tickets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-managed-home-"));
  try {
    const home = path.join(root, "JointBob");
    await ensureManagedHome(home);
    const ignore = await readFile(path.join(home, ".gitignore"), "utf8");

    assert.match(ignore, /^\/projects\/$/m);
    assert.match(ignore, /^\/tickets\/$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed project folders are lowercase snake_case", () => {
  const home = path.join(os.tmpdir(), `joint-bob-folder-case-${randomUUID()}`);

  assert.equal(managedProjectPath(home, "personal", "Guitar Player"), path.join(home, "personal", "guitar_player"));
  assert.equal(managedProjectPath(home, "personal", "  Home Assistant Plugins  "), path.join(home, "personal", "home_assistant_plugins"));
  assert.equal(managedProjectPath(home, "client-work", "ACME Portal"), path.join(home, "client-work", "acme_portal"));
  // A hyphenated type id keeps its hyphens; only the case changes.
  assert.equal(managedTypeRoot(home, "Client-Work"), path.join(home, "client-work"));
});

test("managed project paths cannot escape their type root", () => {
  const home = path.join(os.tmpdir(), `joint-bob-managed-project-${randomUUID()}`);
  for (const name of ["../../escape", "..\\..\\escape", "...", "name/child"]) {
    const result = managedProjectPath(home, "personal", name);
    const relative = path.relative(managedTypeRoot(home, "personal"), result);
    assert.notEqual(relative, "");
    assert.equal(path.isAbsolute(relative), false);
    assert.equal(relative.startsWith(".."), false);
  }
});

test("creates a deterministic ticket workspace from a non-Git project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ticket-workspace-"));
  try {
    const project = path.join(root, "project");
    const ticketRoot = path.join(root, "tickets");
    await mkdir(path.join(project, "src"), { recursive: true });
    await writeFile(path.join(project, "src", "index.ts"), "export const value = 1;\n");

    const workspace = await createTaskWorkspace(project, "project-one", "ticket-one", ticketRoot);

    assert.equal(workspace, expectedTaskWorkspacePath("project-one", "ticket-one", ticketRoot));
    assert.equal(await readFile(path.join(workspace, "src", "index.ts"), "utf8"), "export const value = 1;\n");
    await assertTaskWorkspaceReady("project-one", "ticket-one", ticketRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ticket workspace copy excludes repository metadata, dependencies, builds, logs, and secrets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ticket-filter-"));
  try {
    const project = path.join(root, "project");
    const ticketRoot = path.join(root, "tickets");
    for (const directory of [".git", "packages/nested/.git", "node_modules/pkg", "dist", "coverage", "logs", ".joint-bob", "src"]) {
      await mkdir(path.join(project, directory), { recursive: true });
    }
    await writeFile(path.join(project, "src", "kept.ts"), "kept\n");
    await writeFile(path.join(project, ".env"), "SECRET=value\n");
    await writeFile(path.join(project, "private.pem"), "secret\n");
    await writeFile(path.join(project, ".git", "config"), "git\n");
    await writeFile(path.join(project, "packages", "nested", ".git", "config"), "nested git\n");
    await writeFile(path.join(project, "node_modules", "pkg", "index.js"), "dependency\n");
    await writeFile(path.join(project, "dist", "bundle.js"), "build\n");
    await writeFile(path.join(project, "coverage", "index.html"), "coverage\n");
    await writeFile(path.join(project, "logs", "run.log"), "log\n");
    await writeFile(path.join(project, ".joint-bob", "state"), "state\n");

    const workspace = await createTaskWorkspace(project, "project-two", "ticket-two", ticketRoot);

    assert.equal(await readFile(path.join(workspace, "src", "kept.ts"), "utf8"), "kept\n");
    for (const excluded of [".git", "packages/nested/.git", "node_modules", "dist", "coverage", "logs", ".joint-bob", ".env", "private.pem"]) {
      assert.equal(await missing(path.join(workspace, excluded)), true, excluded);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes a ticket workspace from the synchronized root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ticket-remove-"));
  try {
    const project = path.join(root, "project");
    const ticketRoot = path.join(root, "tickets");
    await mkdir(project);
    await writeFile(path.join(project, "README.md"), "ticket\n");
    const workspace = await createTaskWorkspace(project, "project-three", "ticket-three", ticketRoot);

    await removeTaskWorkspace("project-three", "ticket-three", ticketRoot);

    assert.equal(await missing(workspace), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects task identifiers that could escape the synchronized root", () => {
  assert.throws(() => expectedTaskWorkspacePath("../project", "ticket", "/tmp/tickets"), /invalid/i);
  assert.throws(() => expectedTaskWorkspacePath("project", "../ticket", "/tmp/tickets"), /invalid/i);
});

test("incoming handoff resolves the destination-local synchronized workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ticket-handoff-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousTicketRoot = process.env.JOINT_BOB_TICKET_ROOT;
  const previousHome = process.env.HOME;
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  process.env.JOINT_BOB_TICKET_ROOT = path.join(root, "tickets");
  process.env.HOME = path.join(root, "destination-home");
  try {
    const tasks = await import(new URL(`../src/tasks.ts?ticket-workspace=${Date.now()}`, import.meta.url).href);
    const cluster = await import(new URL(`../src/cluster.ts?ticket-workspace=${Date.now()}`, import.meta.url).href);
    const local = await cluster.getClusterNode();
    const sourceNodeId = randomUUID();
    const taskId = "synced-handoff";
    const projectId = "local-project";
    const sourceWorkspaceKey = "source-project";
    const localWorkspace = expectedTaskWorkspacePath(sourceWorkspaceKey, taskId, process.env.JOINT_BOB_TICKET_ROOT);
    await mkdir(localWorkspace, { recursive: true });
    const incoming = {
      id: taskId, title: "Synced handoff", description: "No Git", status: "backlog" as const, engine: "pi" as const,
      planMode: false, reviewMode: false, phaseConfig: {}, sessionPath: "/source-home/.pi/agent/sessions/synced-handoff.jsonl",
      worktreePath: "/source/tickets/source-project/synced-handoff", worktreeBranch: null, mergedAt: null,
      currentNodeId: sourceNodeId, leaseOwnerNodeId: null, leaseExpiresAt: null, executionState: "idle" as const,
      handoffContext: null, originNodeId: sourceNodeId, createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:00:00.000Z",
    };

    const prepared = await tasks.prepareTaskHandoff(randomUUID(), projectId, projectId, incoming, local.id, null, "", incoming.updatedAt);

    assert.equal(prepared.worktreePath, localWorkspace);
    assert.equal(prepared.worktreeBranch, null);
    assert.equal(prepared.sessionPath, path.join(process.env.HOME, ".pi", "agent", "sessions", "synced-handoff.jsonl"));
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previousDataDir;
    if (previousTicketRoot === undefined) delete process.env.JOINT_BOB_TICKET_ROOT;
    else process.env.JOINT_BOB_TICKET_ROOT = previousTicketRoot;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("server and board expose synchronized ticket archive behavior", async () => {
  const [server, board, app] = await Promise.all([
    readFile("src/server.ts", "utf8"),
    readFile("public/board.js", "utf8"),
    readFile("public/app.js", "utf8"),
  ]);

  assert.equal(TICKET_WORKSPACE_FOLDER_ID, "joint-bob-ticket-workspaces");
  assert.match(server, /tasks\/:taskId\/archive/);
  assert.match(server, /removeTaskWorkspace/);
  assert.match(board, /task\.worktreeBranch/);
  assert.match(app, /\/archive`/);
});
