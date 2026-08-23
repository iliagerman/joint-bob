import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("main pushes deploy exact commits to durable node installations", async () => {
  const [hook, deploy, installer, cli, justfile] = await Promise.all([
    readFile("scripts/hooks/pre-push", "utf8"),
    readFile("scripts/deploy-installed-nodes.sh", "utf8"),
    readFile("scripts/install-git-hooks.sh", "utf8"),
    readFile("bin/joint-bob.mjs", "utf8"),
    readFile("Justfile", "utf8"),
  ]);

  assert.match(hook, /refs\/heads\/main/);
  assert.match(hook, /wait-for-main-and-deploy\.sh/);
  assert.match(deploy, /JOINT_BOB_RELEASE_COMMIT/);
  assert.match(deploy, /joint-bob\.mjs/);
  assert.match(cli, /\.local.*share.*joint-bob.*app/);
  assert.match(deploy, /JOINT_BOB_DEPLOY_SSH_TARGET/);
  assert.doesNotMatch(deploy, /ssh homeserver/);
  assert.match(deploy, /api\/health/);
  assert.match(deploy, /local \| homeserver \| all/);
  assert.match(installer, /hooks\/pre-push/);
  assert.match(justfile, /^update-local:/m);
  assert.match(justfile, /^update-homeserver:/m);
  assert.match(justfile, /^update:/m);
  await access("scripts/wait-for-main-and-deploy.sh");
});
