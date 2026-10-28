import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadPiSdk } from "../src/pi-sdk.js";

/** A stand-in Pi package in a data folder's managed harness. */
async function harness(dataDir: string, version: string, source: string): Promise<string> {
  const packageDir = path.join(dataDir, "harnesses", "pi", "node_modules", "@earendil-works", "pi-coding-agent");
  await mkdir(path.join(packageDir, "dist"), { recursive: true });
  await writeFile(path.join(packageDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version, type: "module", exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } } }));
  await writeFile(path.join(packageDir, "dist", "index.js"), source);
  return path.join(packageDir, "dist", "index.js");
}

test("without a managed Pi harness, conversations use the built-in Pi and say why", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-sdk-missing-"));
  try {
    const loaded = await loadPiSdk(dataDir);
    assert.deepEqual({ ...loaded.status, version: typeof loaded.status.version }, { source: "built-in", version: "string", reason: "the managed Pi harness is not installed yet", harnessVersion: null });
    assert.equal(loaded.entry, null);
    assert.equal(typeof loaded.sdk.ModelRuntime, "function");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("the managed harness's Pi runs from a frozen copy that later harness updates do not touch", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-sdk-harness-"));
  try {
    const live = await harness(dataDir, "9.9.1", 'export const VERSION = "9.9.1"; export const origin = "first install";\n');
    await mkdir(path.join(dataDir, "pi-sdk", "9.9.0", "node_modules"), { recursive: true });
    const loaded = await loadPiSdk(dataDir);
    assert.deepEqual(loaded.status, { source: "harness", version: "9.9.1", reason: null, harnessVersion: "9.9.1" });
    assert.equal(loaded.entry, path.join(dataDir, "pi-sdk", "9.9.1", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"));
    assert.equal((loaded.sdk as unknown as { origin: string }).origin, "first install");
    assert.deepEqual(await readdir(path.join(dataDir, "pi-sdk")), ["9.9.1"], "copies of other versions are removed");
    await writeFile(live, 'export const VERSION = "9.9.1"; export const origin = "replaced";\n');
    assert.match(await readFile(loaded.entry!, "utf8"), /first install/, "the running copy is not the harness folder");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("a harness Pi that cannot load falls back to the built-in Pi and names the version", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-sdk-broken-"));
  try {
    await harness(dataDir, "9.9.2", 'throw new Error("incompatible fixture");\n');
    const loaded = await loadPiSdk(dataDir);
    assert.equal(loaded.status.source, "built-in");
    assert.equal(loaded.status.harnessVersion, "9.9.2");
    assert.match(loaded.status.reason!, /^Pi 9\.9\.2 from the managed harness could not load: incompatible fixture$/);
    assert.equal(loaded.entry, null);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("a worker runs exactly the copy its server chose", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-sdk-worker-"));
  try {
    const entry = await harness(dataDir, "9.9.3", 'export const VERSION = "9.9.3"; export const origin = "server copy";\n');
    const loaded = await loadPiSdk(path.join(dataDir, "unrelated"), { entry });
    assert.deepEqual([loaded.status.source, loaded.status.version, loaded.entry], ["harness", "9.9.3", entry]);
    assert.equal((loaded.sdk as unknown as { origin: string }).origin, "server copy");
    const builtInServer = await loadPiSdk(dataDir, { entry: undefined });
    assert.deepEqual([builtInServer.status.source, builtInServer.status.reason], ["built-in", "the server runs the built-in Pi"], "never the worker's own harness");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
