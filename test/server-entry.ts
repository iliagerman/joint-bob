// Chooses how tests launch the real server. Loading `src/` through the tsx loader costs about a
// second of CPU per process, so nodes run from an esbuild copy of `src/` keyed by the source
// files' content. The copy sits one level under the repository root, like `dist/`, so every
// `../bin`, `../scripts` and `../../public` path the server resolves stays the same.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = process.cwd();
let compiledEntry: string | undefined;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : entry.name.endsWith(".ts") ? [full] : [];
  });
}

function buildCompiledServer(): string {
  const files = sourceFiles(path.join(root, "src")).sort();
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update("\0").update(readFileSync(file)).update("\0");
  const name = `.test-build-${hash.digest("hex").slice(0, 16)}`;
  const outdir = path.join(root, name);
  const entry = path.join(outdir, "server.js");
  try { statSync(entry); return entry; } catch { /* not built yet */ }
  const staging = `${outdir}.tmp-${process.pid}`;
  const esbuild = createRequire(createRequire(import.meta.url).resolve("tsx")).resolve("esbuild");
  createRequire(import.meta.url)(esbuild).buildSync({
    entryPoints: files, outdir: staging, outbase: path.join(root, "src"), platform: "node", format: "esm", target: "node22", logLevel: "error",
  });
  try {
    renameSync(staging, outdir);
  } catch (error) {
    // A concurrent test process published the same build first.
    rmSync(staging, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" && (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const dayAgo = Date.now() - 86_400_000;
  for (const stale of readdirSync(root)) {
    if (!stale.startsWith(".test-build-") || stale === name) continue;
    try { if (statSync(path.join(root, stale)).mtimeMs < dayAgo) rmSync(path.join(root, stale), { recursive: true, force: true }); } catch { /* raced */ }
  }
  return entry;
}

/** Node arguments that start the server. Preloaded probes, stub harnesses and `.ts` override modules need the tsx loader. */
export function serverArgs(env: NodeJS.ProcessEnv, preload: string[] = []): string[] {
  const needsTypeScript = preload.length > 0
    || /--(import|require|loader|experimental-loader)\b/.test(env.NODE_OPTIONS ?? "")
    || Object.values(env).some((value) => typeof value === "string" && /\.[cm]?tsx?(?=$|[\s?#"'])/.test(value));
  if (needsTypeScript || process.env.JOINT_BOB_TEST_TSX_SERVER === "1") return ["--import", "tsx", ...preload.flatMap((file) => ["--import", file]), "src/server.ts"];
  compiledEntry ??= buildCompiledServer();
  return [compiledEntry];
}
