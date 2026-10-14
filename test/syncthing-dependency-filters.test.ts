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
