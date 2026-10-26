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
  assert.match(deploy, /post-deploy-smoke\.sh/);
  assert.match(deploy, /127\.0\.0\.1:8787/);
  assert.match(deploy, /127\.0\.0\.1:8790/);
  assert.match(deploy, /local \| homeserver \| all/);
  // Only the newest backup is kept, older ones go before the new one is written, and one cut short is removed.
  assert.match(deploy, /JOINT_BOB_DEPLOY_BACKUP_KEEP:-1/);
  assert.equal(deploy.match(/pre-deploy-\*\.db 2>\/dev\/null \|\| true; \} \| tail -n "\+\$\{BACKUP_KEEP\}"/g)?.length, 2);
  assert.equal(deploy.match(/rm -f -- "\$\{?backup_db\}?" "\$\{?backup_db\}?-journal"/g)?.length, 2);
  assert.match(installer, /for hook_name in pre-commit pre-push/);
  assert.match(installer, /hooks\/\$\{hook_name\}/);
  assert.match(justfile, /^update-local:/m);
  assert.match(justfile, /^update-homeserver:/m);
  assert.match(justfile, /^update:/m);
  await access("scripts/wait-for-main-and-deploy.sh");
  await access("scripts/post-deploy-smoke.sh");
});
