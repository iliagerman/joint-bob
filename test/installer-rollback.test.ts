import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function waitForMarker(marker: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await readFile(marker, "utf8");
      return;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("New installer did not start");
}

test("remote upgrade restores the prior release when interrupted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "master-bob-rollback-"));
  const installDir = path.join(root, "install", "app");
  const archiveRoot = path.join(root, "archive");
  const releaseDir = path.join(archiveRoot, "release");
  const archive = path.join(root, "release.tar.gz");
  const installer = path.join(root, "install.sh");
  const marker = path.join(root, "new-installer-started");
  const fakeBin = path.join(root, "bin");
  const ref = "a".repeat(40);

  try {
    await mkdir(path.join(installDir, "scripts"), { recursive: true });
    await writeFile(path.join(installDir, ".master-bob-release"), "old release\n");
    await writeFile(path.join(installDir, "old-release.txt"), "old release\n");
    await writeFile(path.join(installDir, "scripts", "install-service.sh"), "#!/usr/bin/env bash\nprintf 'old installer\\n'\n");
    await chmod(path.join(installDir, "scripts", "install-service.sh"), 0o755);

    await mkdir(path.join(releaseDir, "scripts"), { recursive: true });
    await writeFile(path.join(releaseDir, "package.json"), "{}\n");
    await writeFile(path.join(releaseDir, "scripts", "install-service.sh"), "#!/usr/bin/env bash\nprintf 'started\\n' > \"${INSTALLER_MARKER}\"\nsleep 30\n");
    await chmod(path.join(releaseDir, "scripts", "install-service.sh"), 0o755);
    await execFileAsync("tar", ["-czf", archive, "-C", archiveRoot, "release"]);

    await cp("scripts/install.sh", installer);
    await chmod(installer, 0o755);
    await mkdir(fakeBin);
    await writeFile(path.join(fakeBin, "curl"), "#!/usr/bin/env bash\nset -euo pipefail\ncp \"${PREPARED_ARCHIVE}\" \"${4}\"\n");
    await chmod(path.join(fakeBin, "curl"), 0o755);

    const checksum = createHash("sha256").update(await readFile(archive)).digest("hex");
    const child = spawn("bash", [installer], {
      detached: true,
      env: {
        ...process.env,
        HOME: path.join(root, "home"),
        INSTALLER_MARKER: marker,
        MASTER_BOB_ARCHIVE_SHA256: checksum,
        MASTER_BOB_INSTALL_DIR: installDir,
        MASTER_BOB_REF: ref,
        PATH: `${fakeBin}:${process.env.PATH}`,
        PREPARED_ARCHIVE: archive,
      },
    });
    const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });

    await waitForMarker(marker);
    process.kill(-child.pid!, "SIGTERM");
    const result = await completion;

    assert.notEqual(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(await readFile(path.join(installDir, ".master-bob-release"), "utf8"), "old release\n");
    assert.equal(await readFile(path.join(installDir, "old-release.txt"), "utf8"), "old release\n");
    assert.equal(await readFile(path.join(installDir, "scripts", "install-service.sh"), "utf8"), "#!/usr/bin/env bash\nprintf 'old installer\\n'\n");
    assert.deepEqual((await readdir(path.dirname(installDir))).filter((entry) => entry.startsWith(".master-bob-install.")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
