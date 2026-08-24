import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("blank runtime overrides expose effective Pi and Claude paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-runtime-defaults-"));
  const home = path.join(root, "home");
  const bin = path.join(home, "bin");
  const piExecutable = path.join(bin, "pi");
  const claudeExecutable = path.join(bin, "claude");
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  await mkdir(bin, { recursive: true });
  await Promise.all([
    writeFile(piExecutable, "#!/bin/sh\n", { mode: 0o755 }),
    writeFile(claudeExecutable, "#!/bin/sh\n", { mode: 0o755 }),
  ]);
  process.env.HOME = home;
  process.env.PATH = bin;
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  try {
    const settings = await import(`../src/settings.js?defaults=${Date.now()}-${Math.random()}`);
    assert.deepEqual(settings.getSettings().pi, {
      executable: piExecutable,
      configPath: path.join(home, ".pi", "agent"),
      sessionPath: path.join(home, ".pi", "agent", "sessions"),
    });
    assert.deepEqual(settings.getSettings().claude, {
      executable: claudeExecutable,
      configPath: path.join(home, ".claude"),
      sessionPath: path.join(home, ".claude", "projects"),
    });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  }
});
