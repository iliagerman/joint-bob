import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProjectRecord } from "../src/types.js";

function project(id: string, projectPath: string): ProjectRecord {
  return {
    id,
    name: id,
    path: projectPath,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function waitForCallbacks(callbacks: Map<string, string[]>, expectedPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error("timed out waiting for flat session notifications"));
    }, 4_000);
    const interval = setInterval(() => {
      if (callbacks.size === 2 && [...callbacks.values()].every((files) => files.length === 1 && files[0] === expectedPath)) {
        clearTimeout(timeout);
        clearInterval(interval);
        resolve();
      }
    }, 10);
  });
}

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
      }, 5_000);
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

test("shared flat Pi session watcher notifies every project", async () => {
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

    const transcript = path.join(flatRoot, "flat-session.jsonl");
    await writeFile(transcript, "{\"type\":\"session\"}\n");
    await waitForCallbacks(callbacks, transcript);
    assert.deepEqual(callbacks.get("a"), [transcript]);
    assert.deepEqual(callbacks.get("b"), [transcript]);

    await writeFile(path.join(flatRoot, "ignored.txt"), "ignored\n");
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(callbackCount, 2);
  } finally {
    watcher?.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
