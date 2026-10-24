import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startNativeSyncthing, stopNativeSyncthing } from "./native-syncthing.js";

const dependencies = [
  "node_modules/pkg/index.js", ".venv/lib/pkg.py", "venv/lib/pkg.py",
  "site-packages/pkg/__init__.py", "dist-packages/pkg/__init__.py", "__pypackages__/3.12/lib/pkg.py",
  ".tox/py/lib/pkg.py", ".nox/test/lib/pkg.py", ".eggs/pkg/index.py", "pkg.egg-info/PKG-INFO",
  ".npm/_cacache/content", ".pnpm-store/v3/content", ".yarn/cache/pkg.zip", ".yarn/unplugged/pkg/index.js",
  ".cache/pip/wheels/content", ".cache/uv/archive/content", ".nuget/packages/pkg/README.md",
  ".gradle/caches/content", ".m2/repository/pkg/content", "pkg.WHL", "pkg.egg", "pkg.pyc", "pkg.pyo",
  "pkg.NUPKG", "pkg.snupkg",
];
const sourceFiles = ["src/main.py", "packages/ui/index.ts", "bin/start.sh", "NuGet.Config", "packages.lock.json", "pyproject.toml", "uv.lock", "pnpm-lock.yaml"];

interface IndexedEntry { name: string; children?: IndexedEntry[] }
function indexedPaths(entries: IndexedEntry[], prefix = ""): string[] {
  return entries.flatMap((entry) => [prefix + entry.name, ...indexedPaths(entry.children ?? [], `${prefix}${entry.name}/`)]);
}

async function populate(directory: string): Promise<void> {
  for (const prefix of ["", "nested/backend/"]) for (const file of [...dependencies, ...sourceFiles]) {
    const target = path.join(directory, prefix, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "synthetic fixture\n");
  }
}

test("native Syncthing excludes installed packages at every depth but keeps source packages and lockfiles", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sync-dependency-filters-"));
  const previousUrl = process.env.JOINT_BOB_SYNCTHING_URL;
  const previousKey = process.env.JOINT_BOB_SYNCTHING_API_KEY;
  const sync = await startNativeSyncthing(path.join(root, "syncthing"));
  try {
    process.env.JOINT_BOB_SYNCTHING_URL = sync.url;
    process.env.JOINT_BOB_SYNCTHING_API_KEY = sync.key;
    const { ensureSyncthingFolder, rescanSyncthingFolder } = await import("../src/syncthing.ts");
    for (const folder of ["project", "joint-bob-worktrees-fixture"]) {
      const directory = path.join(root, folder);
      await populate(directory);
      await ensureSyncthingFolder(folder, folder, directory);
      await rescanSyncthingFolder(folder);
      const indexed = indexedPaths(await sync.request<IndexedEntry[]>(`db/browse?folder=${folder}&levels=10`));
      for (const prefix of ["", "nested/backend/"]) {
        for (const file of sourceFiles) assert.ok(indexed.includes(prefix + file), `${folder}: source ${prefix + file} must sync`);
        for (const file of dependencies) assert.ok(!indexed.includes(prefix + file), `${folder}: dependency ${prefix + file} must not sync`);
      }
    }
  } finally {
    if (previousUrl === undefined) delete process.env.JOINT_BOB_SYNCTHING_URL;
    else process.env.JOINT_BOB_SYNCTHING_URL = previousUrl;
    if (previousKey === undefined) delete process.env.JOINT_BOB_SYNCTHING_API_KEY;
    else process.env.JOINT_BOB_SYNCTHING_API_KEY = previousKey;
    await stopNativeSyncthing(sync.child);
    await rm(root, { recursive: true, force: true });
  }
});

const uuid = "0b9c6f1e-2d3a-4c5b-8e7f-a1b2c3d4e5f6";
const halfWritten = [
  `.creating-${uuid}/README.md`, `worktree.json.${uuid}.tmp`, `.settings.json.${uuid}.tmp`, `.${uuid}.tmp`,
  `.notes.md.jb-merge-${uuid}.tmp`, `notes.md.jb-rollback-${uuid}.tmp`, ".joint-bob-sync.README.md.0123456789abcdef.tmp",
  `.joint-bob-worktree/worktree.json.${uuid}.tmp`, ".joint-bob-worktrees/feature/README.md",
];
const shared = [
  ".joint-bob-worktree/worktree.json", ".joint-bob-attachments/notes.txt", ".joint-bob-baseline/manifest.json",
  "notes.sync-conflict-20261006-173252-5CHB2CY.md", "plain.tmp", "foo.12345678.tmp", `abc-${uuid}.tmp`, `abc.${uuid}.tmpl`,
  `${uuid}.json`, "creating-notes.md", ".joint-bob-worktrees-old/README.md", "joint-bob-worktrees/README.md",
];

test("native Syncthing keeps half-written files and local branch worktrees out but syncs conflict copies and shared metadata", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sync-half-written-"));
  const previousUrl = process.env.JOINT_BOB_SYNCTHING_URL;
  const previousKey = process.env.JOINT_BOB_SYNCTHING_API_KEY;
  const sync = await startNativeSyncthing(path.join(root, "syncthing"));
  try {
    process.env.JOINT_BOB_SYNCTHING_URL = sync.url;
    process.env.JOINT_BOB_SYNCTHING_API_KEY = sync.key;
    const { ensureSyncthingFolder, reconcileSyncthingProjectFolders, rescanSyncthingFolder, resetSyncthingConnection } = await import("../src/syncthing.ts");
    resetSyncthingConnection();
    for (const folder of ["project", "joint-bob-worktrees-fixture"]) {
      const directory = path.join(root, folder);
      for (const prefix of ["", "nested/deep/"]) for (const file of [...halfWritten, ...shared]) {
        const target = path.join(directory, prefix, file);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, "synthetic fixture\n");
      }
      await ensureSyncthingFolder(folder, folder, directory);
      await rescanSyncthingFolder(folder);
      const indexed = indexedPaths(await sync.request<IndexedEntry[]>(`db/browse?folder=${folder}&levels=10`));
      for (const prefix of ["", "nested/deep/"]) {
        for (const file of shared) assert.ok(indexed.includes(prefix + file), `${folder}: ${prefix + file} must sync`);
        for (const file of halfWritten) assert.ok(!indexed.includes(prefix + file), `${folder}: ${prefix + file} must stay local`);
      }
    }

    // Reconciliation sets a worktree folder's pull order with a PATCH that leaves the rest of its configuration alone.
    const endpoint = "config/folders/joint-bob-worktrees-fixture";
    const before = await sync.request<{ order: string; path: string; devices: unknown[] }>(endpoint);
    await sync.request(endpoint, { ...before, order: "random" });
    await reconcileSyncthingProjectFolders([{ syncFolderId: "project" }]);
    const after = await sync.request<{ order: string; path: string; devices: unknown[] }>(endpoint);
    assert.deepEqual(after, { ...before, order: "smallestFirst" });
  } finally {
    if (previousUrl === undefined) delete process.env.JOINT_BOB_SYNCTHING_URL;
    else process.env.JOINT_BOB_SYNCTHING_URL = previousUrl;
    if (previousKey === undefined) delete process.env.JOINT_BOB_SYNCTHING_API_KEY;
    else process.env.JOINT_BOB_SYNCTHING_API_KEY = previousKey;
    await stopNativeSyncthing(sync.child);
    await rm(root, { recursive: true, force: true });
  }
});
