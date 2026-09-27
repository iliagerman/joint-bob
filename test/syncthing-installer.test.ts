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
