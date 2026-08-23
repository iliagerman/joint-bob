import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runRunner(port?: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-service-port-"));
  try {
    const scripts = path.join(root, "scripts");
    const state = path.join(root, "state");
    const bin = path.join(root, "bin");
    await mkdir(scripts, { recursive: true });
    await mkdir(state);
    await mkdir(bin);
    await cp("scripts/run-node.sh", path.join(scripts, "run-node.sh"));
    await chmod(path.join(scripts, "run-node.sh"), 0o755);
    await writeFile(path.join(state, "env"), port ? `PORT=${port}\n` : "PI_CLAUDE_MCP_AUTOLOAD=off\n");
    await writeFile(path.join(bin, "npm"), "#!/usr/bin/env bash\nprintf 'PORT:%s\\n' \"${PORT}\"\n");
    await chmod(path.join(bin, "npm"), 0o755);
    const { PORT: _port, ...environment } = process.env;
    const result = await execFileAsync("bash", [path.join(scripts, "run-node.sh")], {
      env: { ...environment, PATH: `${bin}:${environment.PATH}`, PI_WEB_DATA_DIR: state },
    });
    return result.stdout.trim();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("runner uses the persisted port and defaults to 8787 when it is absent", async () => {
  assert.equal(await runRunner("9123"), "PORT:9123");
  assert.equal(await runRunner(), "PORT:8787");
});

test("installer computes and polls one port after sourcing persisted state", async () => {
  const installer = await readFile("scripts/install-service.sh", "utf8");
  const sourceIndex = installer.indexOf('source "${STATE_DIR}/env"');
  const portIndex = installer.indexOf('PORT_VALUE="${PORT:-8787}"');
  const healthIndex = installer.indexOf('curl -fsS "http://127.0.0.1:${PORT_VALUE}/api/health"');

  assert.ok(sourceIndex >= 0);
  assert.ok(portIndex > sourceIndex);
  assert.ok(healthIndex > portIndex);
});
