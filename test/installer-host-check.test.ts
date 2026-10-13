import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Runs the host check against a pretended kernel and user systemd session. */
async function checkHost(host: { kernel: string; release?: string; systemd?: boolean; installDir?: string }) {
  const bin = await mkdtemp(path.join(os.tmpdir(), "host-check-"));
  try {
    await writeFile(path.join(bin, "uname"), `#!/bin/bash\nif [ "$1" = -r ]; then echo '${host.release ?? "6.8.0-generic"}'; else echo '${host.kernel}'; fi\n`);
    await writeFile(path.join(bin, "systemctl"), `#!/bin/bash\nexit ${host.systemd === false ? 1 : 0}\n`);
    await chmod(path.join(bin, "uname"), 0o755);
    await chmod(path.join(bin, "systemctl"), 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, JOINT_BOB_INSTALL_DIR: host.installDir ?? "/home/bob/.local/share/joint-bob/app" };
    try {
      const { stderr } = await execFileAsync("bash", ["scripts/check-host.sh"], { env });
      return { code: 0, stderr };
    } catch (error) {
      const failure = error as { code?: number; stderr?: string };
      return { code: failure.code ?? 1, stderr: failure.stderr ?? "" };
    }
  } finally { await rm(bin, { recursive: true, force: true }); }
}

test("macOS and Linux with a user systemd session pass the host check", async () => {
  assert.deepEqual(await checkHost({ kernel: "Darwin" }), { code: 0, stderr: "" });
  assert.deepEqual(await checkHost({ kernel: "Linux" }), { code: 0, stderr: "" });
  assert.deepEqual(await checkHost({ kernel: "Linux", release: "5.15.167.4-microsoft-standard-WSL2" }), { code: 0, stderr: "" });
});

test("WSL 2 without systemd is told how to enable it", async () => {
  const result = await checkHost({ kernel: "Linux", release: "5.15.167.4-microsoft-standard-WSL2", systemd: false });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\/etc\/wsl\.conf/);
  assert.match(result.stderr, /systemd=true/);
  assert.match(result.stderr, /wsl --shutdown/);
});

test("WSL 1 and Windows shells are sent to WSL 2", async () => {
  const wsl1 = await checkHost({ kernel: "Linux", release: "4.4.0-19041-Microsoft" });
  assert.equal(wsl1.code, 1);
  assert.match(wsl1.stderr, /wsl --set-version/);
  for (const kernel of ["MINGW64_NT-10.0-22631", "MSYS_NT-10.0", "CYGWIN_NT-10.0"]) {
    const result = await checkHost({ kernel });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /WSL 2/);
    assert.match(result.stderr, /#install-on-windows/);
  }
});

test("Linux without a user systemd session fails before anything is built", async () => {
  const result = await checkHost({ kernel: "Linux", systemd: false });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /systemctl --user show-environment/);
  assert.doesNotMatch(result.stderr, /wsl/i);
});

test("installing onto a Windows drive from WSL only warns", async () => {
  const result = await checkHost({ kernel: "Linux", release: "6.6.87.2-microsoft-standard-WSL2", installDir: "/mnt/c/joint-bob/app" });
  assert.equal(result.code, 0);
  assert.match(result.stderr, /Windows drive/);
});

test("both installer entry points run the host check before building, and updates do not", async () => {
  const [bootstrap, installer, cli] = await Promise.all([
    readFile("scripts/install.sh", "utf8"),
    readFile("scripts/install-service.sh", "utf8"),
    readFile("bin/joint-bob.mjs", "utf8"),
  ]);
  const remoteCheck = bootstrap.indexOf('bash "${verified_source}/scripts/check-host.sh"');
  assert.ok(remoteCheck > bootstrap.indexOf("tar -xzf"), "only a checksum-verified archive is executed");
  assert.ok(remoteCheck < bootstrap.indexOf("install-node-runtime.sh"));
  const sourceCheck = installer.indexOf('bash "${REPO_ROOT}/scripts/check-host.sh"');
  assert.ok(sourceCheck >= 0 && sourceCheck < installer.indexOf("install-node-runtime.sh"));
  assert.equal(installer.split("check-host.sh").length, 2, "an installed node's update must not depend on the host check");
  assert.doesNotMatch(cli, /check-host/);
});

test("the Windows installer drives the Linux installer inside WSL and keeps the distribution running", async () => {
  const script = await readFile("scripts/install-windows.ps1", "utf8");
  assert.match(script, /^param\(/m, "options must work when the script is piped to iex");
  assert.match(script, /scripts\/install\.sh|\$scriptsUrl\/install\.sh/);
  assert.match(script, /systemd=true/);
  assert.match(script, /loginctl", "enable-linger"/);
  assert.match(script, /Register-ScheduledTask/);
  assert.match(script, /--exec \/bin\/sleep infinity/);
  // The embedded bash snippets end with "exit 0"; a PowerShell exit would close the window the script was piped into.
  assert.doesNotMatch(script, /^\s*exit(?! 0$)/m);
  assert.doesNotMatch(script, /\r/);
});

test("the Windows installer installs WSL and Ubuntu itself, with consent and administrator approval", async () => {
  const script = await readFile("scripts/install-windows.ps1", "utf8");
  // Installing WSL changes the system, so it is asked for unless -Force, and -SkipWslInstall refuses instead.
  assert.match(script, /\[switch\]\$SkipWslInstall/);
  assert.match(script, /Read-Host "WSL is not set up\./);
  assert.match(script, /if \(\$SkipWslInstall\) \{ throw/);
  // Elevation goes through the Windows prompt only when the script is not already elevated.
  assert.match(script, /"--install", "-d", \$Name, "--no-launch"/);
  assert.match(script, /-Verb RunAs -Wait -PassThru/);
  assert.match(script, /if \(Test-Elevated\)/);
  // A restart can be needed before the distribution is registered; the script then says so instead of failing later.
  assert.match(script, /Restart Windows, then run this same command again/);
  // The Linux user is created as root, named after the Windows user, without a password, and made the default.
  assert.match(script, /-u", "root", "--", "bash", "-s"/);
  assert.match(script, /useradd --create-home --shell \/bin\/bash __USER__/);
  assert.match(script, /default=__USER__/);
  assert.match(script, /--set-default", \$Name/);
  assert.doesNotMatch(script, /ConvertTo-SecureString|-Password/i, "the script never handles a password");
});
