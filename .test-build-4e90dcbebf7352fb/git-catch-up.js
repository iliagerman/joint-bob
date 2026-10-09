import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "./subprocess.js";
const execute = promisify(execFile);
const GIT_TIMEOUT_MS = 1e4;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
async function run(cwd, env, args, input) {
  const pending = execute("git", ["-C", cwd, ...args], {
    env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES
  });
  if (input !== void 0) pending.child.stdin.end(input);
  try {
    return { stdout: (await pending).stdout, stderr: "", code: 0 };
  } catch (error) {
    const failure = error;
    if (failure.code === 1 || failure.code === 128) return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code };
    throw new Error(`git ${args[0]} failed: ${failure.stderr?.trim() || failure.message}`);
  }
}
async function git(cwd, env, args, input) {
  const result = await run(cwd, env, args, input);
  if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}
async function exists(file) {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function filesMatchCommit(root, env, from, to) {
  const fields = (await git(root, env, ["diff", "--raw", "-z", "--no-renames", "--no-abbrev", from, to])).split("\0");
  const expected = /* @__PURE__ */ new Map();
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [, mode, , blob, status] = fields[index].split(" ");
    const file = fields[index + 1];
    const present = await exists(path.join(root, file));
    if (status === "D") {
      if (present) return false;
      continue;
    }
    if (!present || mode === "160000") return false;
    expected.set(file, blob);
  }
  if (expected.size === 0) return true;
  const files = [...expected.keys()];
  const hashes = (await git(root, env, ["hash-object", "--stdin-paths"], `${files.join("\n")}
`)).trim().split("\n");
  return files.every((file, index) => hashes[index] === expected.get(file));
}
async function catchUp(root, env) {
  if ((await run(root, env, ["rev-parse", "--symbolic-full-name", "@{upstream}"])).code !== 0) return "no-upstream";
  await git(root, env, ["fetch", "--quiet"]);
  const head = (await git(root, env, ["rev-parse", "HEAD"])).trim();
  const upstream = (await git(root, env, ["rev-parse", "@{upstream}"])).trim();
  if (head === upstream) return "current";
  if ((await run(root, env, ["merge-base", "--is-ancestor", head, upstream])).code !== 0) return "local-commits";
  if ((await run(root, env, ["diff", "--cached", "--quiet"])).code !== 0) return "staged-changes";
  if (!await filesMatchCommit(root, env, head, upstream)) return "files-not-synced";
  await git(root, env, ["reset", "--mixed", "--quiet", upstream]);
  return "moved";
}
const inFlight = /* @__PURE__ */ new Map();
async function catchUpGitHead(cwd, env) {
  const top = await run(cwd, env, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return "not-repository";
  const root = top.stdout.trim();
  const running = inFlight.get(root);
  if (running) return running;
  const pending = catchUp(root, env).finally(() => inFlight.delete(root));
  inFlight.set(root, pending);
  return pending;
}
export {
  catchUpGitHead
};
