import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("managed Syncthing never upgrades itself away from the pinned version", async () => {
  const installer = await readFile("scripts/install-syncthing.sh", "utf8");
  assert.match(installer, /\[Service\]\n(?:#.*\n)*Environment=STNOUPGRADE=1\n/, "the systemd unit disables Syncthing's self-upgrade");
  assert.match(installer, /<key>EnvironmentVariables<\/key><dict><key>STNOUPGRADE<\/key><string>1<\/string><\/dict>/, "the launch agent disables Syncthing's self-upgrade");
});

test("a reinstall replaces the Syncthing binary by rename, so a running copy cannot block it", async () => {
  const installer = await readFile("scripts/install-syncthing.sh", "utf8");
  assert.match(installer, /cp "\$\{extracted_binary\}" "\$\{BINARY\}\.new"\n[\s\S]*mv -f "\$\{BINARY\}\.new" "\$\{BINARY\}"/);
  assert.doesNotMatch(installer, /cp "\$\{extracted_binary\}" "\$\{BINARY\}"\n/, "copying over the binary fails with 'Text file busy' while Syncthing runs");
});

// The person's own Syncthing (their systemd unit) and Joint Bob's used the same home and lock.
// Joint Bob's was installed beside it whenever one `cli show system` failed (say, during the
// person's self-upgrade restart) and then lost the lock at every boot, restarting every 5 s.
test("the installer uses the person's own Syncthing unit instead of adding a second one", { skip: process.platform === "win32" }, async (t) => {
  const { mkdtemp, mkdir, readFile: read, rm, writeFile, access } = await import("node:fs/promises");
  const { execFile } = await import("node:child_process");
  const os = await import("node:os");
  const path = await import("node:path");
  const version = /JOINT_BOB_SYNCTHING_VERSION="?([^"\n]+)"?/.exec(await read("scripts/versions.sh", "utf8"))![1];
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-syncthing-installer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin"), state = path.join(root, "state"), log = path.join(root, "systemctl.log");
  await mkdir(bin);
  await mkdir(state);
  const script = async (name: string, body: string) => writeFile(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  await script("uname", `[ "$1" = "-s" ] && { echo Linux; exit 0; }; exec /usr/bin/uname "$@"`);
  await script("systemctl", [
    `echo "$*" >> "${log}"`,
    `case "$*" in`,
    `  "--user is-enabled --quiet syncthing.service") [ -e "${state}/own-unit" ] ;;`,
    `  "is-enabled --quiet syncthing@"*) exit 1 ;;`,
    `  "--user start syncthing.service"|"--user enable --now joint-bob-syncthing.service") touch "${state}/running" ;;`,
    `esac`,
  ].join("\n"));
  await script("syncthing", [
    `[ "$1" = "--version" ] && { echo "syncthing v${version} \\"stub\\""; exit 0; }`,
    `[ "$1 $2 $3" = "cli show system" ] && [ -e "${state}/running" ]`,
  ].join("\n"));
  const unitDir = path.join(root, "home", ".config", "systemd", "user"), unit = path.join(unitDir, "joint-bob-syncthing.service");
  const install = () => new Promise<string>((resolve, reject) => execFile("bash", ["scripts/install-syncthing.sh"], {
    env: { ...process.env, HOME: path.join(root, "home"), PATH: `${bin}:${process.env.PATH}`, JOINT_BOB_SYNCTHING_BIN: path.join(bin, "syncthing"), JOINT_BOB_RUNTIME_DIR: path.join(root, "runtime"), XDG_RUNTIME_DIR: root, XDG_STATE_HOME: path.join(root, "home", ".local", "state") },
  }, (error, stdout, stderr) => error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout)));
  const exists = (file: string) => access(file).then(() => true, () => false);

  // The person's own unit is enabled but restarting, and an older install left ours beside it.
  await writeFile(path.join(state, "own-unit"), "");
  await mkdir(unitDir, { recursive: true });
  await writeFile(unit, "[Service]\nExecStart=old\n");
  await install();
  assert.equal(await exists(unit), false, "the second unit is removed");
  const calls = await read(log, "utf8");
  assert.match(calls, /--user start syncthing\.service/, "the person's own unit is started and waited for");
  assert.doesNotMatch(calls, /enable --now joint-bob-syncthing/, "ours is not installed beside it");

  // With no Syncthing of the person's, ours is installed, and it stands down for another holder of the lock.
  await rm(path.join(state, "own-unit"));
  await rm(path.join(state, "running"));
  await install();
  const written = await read(unit, "utf8");
  assert.match(written, /ExecCondition=.*flock -n/, "a held lock skips the start instead of failing it");
  assert.match(written, /StartLimitBurst=5/, "systemd gives up on a unit that keeps failing");
});
