import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const runner = path.resolve("scripts/run-node.sh");
const repoRoot = path.resolve(".");

async function fixture(t: TestContext, options: { platform?: string; xvfb?: boolean; xauth?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-virtual-display-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const log = path.join(root, "calls.log");
  const data = path.join(root, "data");
  await mkdir(bin);
  const stub = async (name: string, body: string) => writeFile(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  const logger = (command: string) => {
    const script = `const fs=require("node:fs");fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({command:process.argv[1],args:process.argv.slice(2)})+"\\n")`;
    return `${shellQuote(process.execPath)} -e ${shellQuote(script)} ${shellQuote(command)} "$@"`;
  };
  await stub("node", logger("node"));
  await stub("dirname", "exec /usr/bin/dirname \"$@\"");
  await stub("awk", "exec /usr/bin/awk \"$@\"");
  await stub("uname", `${logger("uname")}; printf '%s\\n' ${shellQuote(options.platform ?? "Linux")}`);
  if (options.xvfb !== false) await stub("xvfb-run", logger("xvfb"));
  if (options.xauth !== false) await stub("xauth", "exit 0");
  const env = { ...process.env, HOME: root, JOINT_BOB_DATA_DIR: data, PATH: bin };
  delete env.JOINT_BOB_BROWSER_MODE;
  return { log, data, env };
}

async function calls(log: string): Promise<Array<{ command: string; args: string[] }>> {
  const text = await readFile(log, "utf8").catch(() => "");
  return text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { command: string; args: string[] });
}

const supervisorArgs = (data: string) => [path.join(repoRoot, "scripts/supervisor-service.mjs"), repoRoot, data];

test("runner starts the supervisor directly in headless mode by default", async t => {
  const f = await fixture(t);
  const result = spawnSync("/bin/bash", [runner], { env: f.env, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await calls(f.log), [{ command: "node", args: supervisorArgs(f.data) }]);
});

test("runner wraps the supervisor in private Linux Xvfb for virtual mode", async t => {
  const f = await fixture(t);
  const result = spawnSync("/bin/bash", [runner], { env: { ...f.env, JOINT_BOB_BROWSER_MODE: "virtual", DISPLAY: ":inherited" }, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await calls(f.log), [
    { command: "uname", args: ["-s"] },
    { command: "xvfb", args: ["--auto-servernum", "--server-args=-screen 0 1100x740x24 -nolisten tcp", "node", ...supervisorArgs(f.data)] },
  ]);
});

for (const scenario of [
  { name: "non-Linux virtual mode", options: { platform: "Darwin" }, mode: "virtual", error: /only.*Linux/i },
  { name: "invalid mode", options: {}, mode: "visible", error: /headless or virtual/i },
  { name: "missing Xvfb dependency", options: { xvfb: false }, mode: "virtual", error: /xvfb-run/i },
  { name: "missing xauth dependency", options: { xauth: false }, mode: "virtual", error: /xauth/i },
]) test(`runner rejects ${scenario.name} without supervisor launch or fallback`, async t => {
  const f = await fixture(t, scenario.options);
  const result = spawnSync("/bin/bash", [runner], { env: { ...f.env, JOINT_BOB_BROWSER_MODE: scenario.mode }, encoding: "utf8", timeout: 5000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, scenario.error);
  assert.equal((await calls(f.log)).some(call => call.command === "node" || call.command === "xvfb"), false);
});
