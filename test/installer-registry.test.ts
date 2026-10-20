import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);

test("installer ignores user, global, scoped and environment private npm registries without changing user settings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "installer-public-registry-"));
  try {
    const home = path.join(root, "home");
    const app = path.join(root, "app");
    const bin = path.join(root, "bin");
    await Promise.all([mkdir(home), mkdir(bin), mkdir(path.join(app, "scripts"), { recursive: true })]);
    const userConfig = path.join(home, ".npmrc");
    const globalConfig = path.join(root, "global.npmrc");
    const privateConfig = "registry=http://127.0.0.1:1/\n@earendil-works:registry=http://127.0.0.1:2/\n";
    await Promise.all([writeFile(userConfig, privateConfig), writeFile(globalConfig, privateConfig)]);
    await copyFile("scripts/install-service.sh", path.join(app, "scripts/install-service.sh"));
    for (const helper of ["run-node.sh", "install-node-runtime.sh", "check-prerequisites.sh", "build-service-path.sh", "install-syncthing.sh"]) {
      await writeFile(path.join(app, "scripts", helper), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    const realNpm = (await exec("which", ["npm"])).stdout.trim();
    const output = path.join(root, "registries.json");
    // Execute the real npm config resolver with the flags the installer supplies to ci.
    // No install or network request is made, and npm sees only disposable configuration.
    await writeFile(path.join(bin, "npm"), `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] !== "ci") process.exit(0);
const flags = args.slice(1);
const values = {};
for (const key of ["registry", "@earendil-works:registry", "userconfig", "globalconfig"]) {
  const result = spawnSync(${JSON.stringify(realNpm)}, ["config", "get", key, ...flags], { encoding: "utf8" });
  if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(1); }
  values[key] = result.stdout.trim();
}
writeFileSync(${JSON.stringify(output)}, JSON.stringify(values));
`, { mode: 0o755 });
    await exec("bash", [path.join(app, "scripts/install-service.sh"), "--build-only"], {
      env: {
        HOME: home,
        PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        JOINT_BOB_DATA_DIR: path.join(root, "data"),
        JOINT_BOB_BROWSER_EXECUTABLE: "/synthetic/browser-not-launched",
        npm_config_registry: "http://127.0.0.1:3/",
        npm_config_userconfig: userConfig,
        npm_config_globalconfig: globalConfig,
        NPM_CONFIG_REGISTRY: "http://127.0.0.1:4/",
        NPM_CONFIG_USERCONFIG: userConfig,
        NPM_CONFIG_GLOBALCONFIG: globalConfig,
      },
    });
    const config = JSON.parse(await readFile(output, "utf8"));
    assert.equal(new URL(config.registry).origin, "https://registry.npmjs.org", "installer must override machine-specific registry configuration");
    assert.equal(config["@earendil-works:registry"], "undefined");
    assert.notEqual(config.userconfig, userConfig);
    assert.notEqual(config.globalconfig, globalConfig);
    assert.notEqual(config.userconfig, config.globalconfig, "npm cannot load the same empty file twice");
    await assert.rejects(readFile(config.userconfig), { code: "ENOENT" }, "temporary config is cleaned up");
    await assert.rejects(readFile(config.globalconfig), { code: "ENOENT" }, "temporary config is cleaned up");
    assert.equal(await readFile(userConfig, "utf8"), privateConfig);
    assert.equal(await readFile(globalConfig, "utf8"), privateConfig);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
