import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function fixture(root: string) {
  const app = path.join(root, "app");
  const tools = path.join(root, "tools");
  const state = path.join(root, "state");
  for (const directory of [path.join(app, "scripts"), tools, state]) await mkdir(directory, { recursive: true });
  await writeFile(path.join(app, "scripts/install-service.sh"), await readFile("scripts/install-service.sh", "utf8"));
  await cp("deploy", path.join(app, "deploy"), { recursive: true });
  for (const script of ["run-node", "install-node-runtime", "check-prerequisites", "build-service-path", "install-syncthing"]) {
    await writeFile(path.join(app, `scripts/${script}.sh`), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  }
  await writeFile(path.join(app, "scripts/install-claude-hooks.mjs"), "");
  await writeFile(path.join(app, "scripts/install-pi-runtime.mjs"), "");
  await writeFile(path.join(state, "node.db"), "");
  const commands: Record<string, string> = {
    node: 'if [ "$1" = --import ]; then echo test-token; else exec "$REAL_NODE" "$@"; fi',
    npm: 'echo "npm $*" >> "$LOG"; [ "$1" = --version ]',
    uname: 'echo "$TEST_PLATFORM"',
    plutil: 'exit 0',
    loginctl: 'echo yes',
    systemctl: 'echo "systemctl $*" >> "$LOG"; if [[ "$*" == *"restart joint-bob.service"* ]]; then touch "$LOG.restarted"; fi; if [[ "$*" == *MainPID* ]]; then if [ -e "$LOG.restarted" ]; then echo 456; else echo 123; fi; fi; exit 0',
    launchctl: 'echo "launchctl $*" >> "$LOG"; touch "$LOG.restarted"',
    curl: `if [[ "$*" == *api/update/prepare* ]]; then
  echo prepare >> "$LOG"
  while [ "$1" != -o ]; do shift; done
  if [ "$PREPARE_STATUS" = 200 ]; then printf '{"ready":true,"recoveryCount":0}' > "$2"; else printf '{"error":"Interrupted work is still recovering; wait before updating again"}' > "$2"; fi
  printf '%s' "$PREPARE_STATUS"
elif [ -e "$LOG.restarted" ]; then
  echo '{"status":"ok","release":"development"}'
else
  # A fenced server is reachable but returns HTTP 503.
  [[ "$*" != *-f* ]] || exit 22
  echo '{"status":"updating"}'
fi`,
  };
  for (const [name, body] of Object.entries(commands)) await writeFile(path.join(tools, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  return { app, env: { ...process.env, HOME: root, JOINT_BOB_DATA_DIR: state, PATH: `${tools}:${process.env.PATH}`, REAL_NODE: process.execPath, LOG: path.join(root, "commands") } };
}

for (const platform of ["Linux", "Darwin"]) {
  for (const status of ["200", "503"]) {
    test(`${platform} activation ${status === "200" ? "prepares before native restart" : "does not restart when preparation fails"}`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "installer-activation-"));
      try {
        const f = await fixture(root);
        const activation = execFileAsync("bash", [path.join(f.app, "scripts/install-service.sh"), "--activate-only"], {
          env: { ...f.env, TEST_PLATFORM: platform, PREPARE_STATUS: status }, timeout: 10_000,
        });
        if (status === "200") await activation;
        else await assert.rejects(activation, /Service update preparation failed \(503\).*Interrupted work is still recovering/);
        const commands = (await readFile(f.env.LOG, "utf8")).trim().split("\n");
        const prepare = commands.indexOf("prepare");
        assert.ok(prepare >= 0, "activation must prepare even when health returns 503");
        const native = commands.findIndex((command) => /^(systemctl|launchctl) /.test(command));
        if (status === "200") assert.ok(native > prepare, "preparation must precede native service mutation");
        else assert.equal(native, -1, "failed preparation must not mutate native service");
        assert.deepEqual(commands.filter((command) => command.startsWith("npm ")), ["npm --version"]);
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
}
