import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeProjectDir } from "../src/harnesses/claude/paths.js";
import type { ProjectRecord } from "../src/types.js";
import { SessionWatcher } from "../src/watcher.js";

function project(id: string, projectPath: string): ProjectRecord {
  return {
    id,
    name: id,
    path: projectPath,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function waitForCallbacks(callbacks: Map<string, string[]>, expectedFiles: string[], expectedProjects = 2): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error("timed out waiting for session notification"));
    }, 4_000);
    const interval = setInterval(() => {
      if (callbacks.size === expectedProjects && [...callbacks.values()].every((files) => JSON.stringify(files) === JSON.stringify(expectedFiles))) {
        clearTimeout(timeout);
        clearInterval(interval);
        resolve();
      }
    }, 10);
  });
}

function waitForCallback(callbacks: Map<string, string[]>, projectId: string, expectedPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error("timed out waiting for project session notification"));
    }, 4_000);
    const interval = setInterval(() => {
      if (callbacks.get(projectId)?.[0] === expectedPath) {
        clearTimeout(timeout);
        clearInterval(interval);
        resolve();
      }
    }, 10);
  });
}

test("projects share one recursive watcher and removing a subscriber keeps it alive", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "session-watcher-shared-"));
  const previousHome = process.env.HOME;
  const root = path.join(home, ".pi/agent/sessions");
  const opened: string[] = [];
  const handles: fs.FSWatcher[] = [];
  const originalWatch = fs.watch;
  const watchMock = t.mock.method(fs, "watch", (...args: Parameters<typeof fs.watch>) => {
    const handle = originalWatch(...args);
    if (typeof args[1] === "object" && args[1] !== null && "recursive" in args[1] && args[1].recursive) {
      opened.push(String(args[0]));
      if (String(args[0]) === root) handles.push(handle);
    }
    return handle;
  });
  syncBuiltinESMExports();
  const callbacks = new Map<string, string[]>();
  const watcher = new SessionWatcher((id, files) => callbacks.set(id, files));
  try {
    process.env.HOME = home;
    await mkdir(root, { recursive: true });
    for (const id of ["a", "b", "c"]) watcher.ensureProject(project(id, path.join(home, id)));
    assert.equal(opened.filter(dir => dir === root).length, 1, "shared transcript root must be watched only once");
    await waitForCallbacks(callbacks, [], 3);
    watcher.removeProject("a");
    callbacks.clear();
    const transcript = path.join(root, "new.jsonl");
    await writeFile(transcript, `${JSON.stringify({ type: "session", cwd: path.join(home, "b") })}\n`);
    await waitForCallback(callbacks, "b", transcript);
    assert.equal(callbacks.has("a"), false);
    handles[0]!.emit("error", Object.assign(new Error("root removed"), { code: "ENOENT" }));
    for (const id of ["b", "c"]) watcher.ensureProject(project(id, path.join(home, id)));
    assert.equal(handles.length, 2, "watcher failure must release all subscribers so one shared watch can reopen");
    watcher.removeProject("b");
    watcher.removeProject("c");
    watcher.ensureProject(project("d", path.join(home, "d")));
    assert.equal(opened.filter(dir => dir === root).length, 3, "last subscriber removal must release the root");
  } finally {
    watcher.close();
    watchMock.mock.restore();
    syncBuiltinESMExports();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("shared flat Pi session watcher does not keep the process alive", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "session-watcher-exit-"));

  try {
    await mkdir(path.join(home, ".pi/agent/sessions"), { recursive: true });
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        'const { SessionWatcher } = await import("./src/watcher.ts"); new SessionWatcher(() => undefined);',
      ],
      { cwd: process.cwd(), env: { ...process.env, HOME: home }, stdio: "ignore" },
    );
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("child process did not exit after constructing SessionWatcher"));
      }, 30_000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    assert.equal(exitCode, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("registering a newly created session root requests one full refresh", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "session-watcher-missing-"));
  const previousHome = process.env.HOME;
  const flatRoot = path.join(home, ".pi/agent/sessions");
  let watcher: import("../src/watcher.js").SessionWatcher | undefined;

  try {
    process.env.HOME = home;
    const { SessionWatcher } = await import(`../src/watcher.ts?missing=${Date.now()}`);
    const callbacks = new Map<string, string[]>();
    let callbackCount = 0;
    watcher = new SessionWatcher((projectId, changedFiles) => {
      callbackCount += 1;
      callbacks.set(projectId, changedFiles);
    });
    watcher.ensureProject(project("missing", path.join(home, "project")));

    await mkdir(flatRoot, { recursive: true });
    await writeFile(path.join(flatRoot, "existing.jsonl"), "{\"type\":\"session\"}\n");
    watcher.ensureProject(project("missing", path.join(home, "project")));
    await writeFile(path.join(flatRoot, "coalesced.jsonl"), "{\"type\":\"session\"}\n");

    await waitForCallbacks(callbacks, [], 1);
    assert.equal(callbackCount, 1);
  } finally {
    watcher?.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("Claude root watcher observes the first transcript in a new project directory", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "session-watcher-claude-first-"));
  const previousHome = process.env.HOME;
  const projectsRoot = path.join(home, ".claude/projects");
  const projectPath = path.join(home, "project");
  let watcher: SessionWatcher | undefined;

  try {
    process.env.HOME = home;
    await mkdir(projectsRoot, { recursive: true });
    const callbacks = new Map<string, string[]>();
    watcher = new SessionWatcher((projectId, changedFiles) => callbacks.set(projectId, changedFiles));
    watcher.ensureProject(project("claude-first", projectPath));

    await waitForCallbacks(callbacks, [], 1);
    callbacks.clear();

    const transcriptDir = claudeProjectDir(projectPath, projectsRoot);
    await mkdir(transcriptDir, { recursive: true });
    const transcript = path.join(transcriptDir, "first.jsonl");
    await writeFile(transcript, `${JSON.stringify({ type: "user", cwd: projectPath })}\n`);

    await waitForCallback(callbacks, "claude-first", transcript);
    assert.deepEqual(callbacks.get("claude-first"), [transcript]);
  } finally {
    watcher?.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("shared flat Pi session watcher notifies only the transcript project", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "session-watcher-"));
  const previousHome = process.env.HOME;
  const flatRoot = path.join(home, ".pi/agent/sessions");
  let watcher: import("../src/watcher.js").SessionWatcher | undefined;

  try {
    process.env.HOME = home;
    await mkdir(flatRoot, { recursive: true });
    const { SessionWatcher } = await import(`../src/watcher.ts?test=${Date.now()}`);
    const callbacks = new Map<string, string[]>();
    let callbackCount = 0;
    watcher = new SessionWatcher((projectId, changedFiles) => {
      callbackCount += 1;
      callbacks.set(projectId, changedFiles);
    });
    watcher.ensureProject(project("a", path.join(home, "project-a")));
    watcher.ensureProject(project("b", path.join(home, "project-b")));

    await waitForCallbacks(callbacks, []);
    callbacks.clear();
    callbackCount = 0;

    const transcript = path.join(flatRoot, "flat-session.jsonl");
    await writeFile(transcript, `${JSON.stringify({ type: "session", cwd: path.join(home, "project-a") })}\n`);
    await waitForCallback(callbacks, "a", transcript);
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.deepEqual(callbacks.get("a"), [transcript]);
    assert.equal(callbacks.has("b"), false, "unrelated projects do not reparse the transcript");

    await writeFile(path.join(flatRoot, "ignored.txt"), "ignored\n");
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(callbackCount, 1);
  } finally {
    watcher?.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
