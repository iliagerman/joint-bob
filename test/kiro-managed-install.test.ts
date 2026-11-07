import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import kiro from "../src/harnesses/kiro.harness.js";
import { resolveDataDirectory } from "../src/data-directory.js";

const execute = promisify(execFile);

test("Kiro defaults to Joint Bob's own binary even before it is installed", () => {
  assert.equal(kiro.configuration!.defaults(os.homedir()).executable, path.join(resolveDataDirectory(), "harnesses/kiro/bin/kiro-cli"));
});

test("managed Kiro selects native v3 packages and rejects unsafe release metadata", async () => {
  const { kiroRelease } = await import("../src/kiro-install.js");
  const filenames = ["kirocli-universal-darwin.tar.gz", "kirocli-x86_64-linux-musl.tar.gz", "kirocli-aarch64-linux-musl.tar.gz"];
  const manifest = { version: "3.1.0", packages: filenames.map(name => ({ download: `3.1.0/${name}`, sha256: "a".repeat(64) })) };
  assert.equal(kiroRelease(manifest, "darwin", "arm64").download, `3.1.0/${filenames[0]}`);
  assert.equal(kiroRelease(manifest, "linux", "x64").download, `3.1.0/${filenames[1]}`);
  assert.equal(kiroRelease(manifest, "linux", "arm64").download, `3.1.0/${filenames[2]}`);
  assert.throws(() => kiroRelease(manifest, "win32", "x64"), /Unsupported/);
  assert.throws(() => kiroRelease({ ...manifest, version: "2.35.0" }, "darwin", "arm64"), /version 3/);
  assert.throws(() => kiroRelease({ ...manifest, packages: [{ download: "https://elsewhere.invalid/kirocli-universal-darwin.tar.gz", sha256: "a".repeat(64) }] }, "darwin", "arm64"), /package/);
});

test("managed Kiro verifies downloads, preserves working installs on failure, and repairs a missing binary", async (t) => {
  const { installManagedKiro, managedKiroExecutable } = await import("../src/kiro-install.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "kiro-release-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixtureBin = path.join(root, "kirocli/bin");
  await mkdir(fixtureBin, { recursive: true });
  const script = '#!/bin/sh\ncase "$*" in\n--version) echo "kiro-cli 3.1.0";;\n"acp --agent-engine=v3 --help") echo "ACP v3";;\n*) exit 19;;\nesac\n';
  await writeFile(path.join(fixtureBin, "kiro-cli"), script, { mode: 0o755 });
  const archive = path.join(root, "fixture.tar.gz");
  await execute("tar", ["-czf", archive, "-C", root, "kirocli"]);
  const bytes = await readFile(archive);
  const filename = process.platform === "darwin" ? "kirocli-universal-darwin.tar.gz" : `kirocli-${process.arch === "arm64" ? "aarch64" : "x86_64"}-linux-musl.tar.gz`;
  let checksum = "0".repeat(64);
  const fetch = t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    const address = String(url);
    if (address.endsWith("/latest/manifest.json")) return Response.json({ version: "3.1.0", packages: [{ download: `3.1.0/${filename}`, sha256: checksum }] });
    assert.equal(address, `https://prod.download.cli.kiro.dev/stable/3.1.0/${filename}`);
    return new Response(bytes);
  });
  const executable = managedKiroExecutable();
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "previous");
  await assert.rejects(installManagedKiro(), /checksum/i);
  assert.equal(await readFile(executable, "utf8"), "previous");
  checksum = createHash("sha256").update(bytes).digest("hex");
  await installManagedKiro();
  assert.equal((await execute(executable, ["--version"])).stdout.trim(), "kiro-cli 3.1.0");
  await rm(executable);
  await installManagedKiro();
  assert.equal(await readFile(executable, "utf8"), script);
  fetch.mock.restore();
});
