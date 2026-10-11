// The server reads people's folders as the service, so in multi-user mode it may only ever
// read a person's own: a project folder in their home, never one they point elsewhere with
// a link, and never transcripts that a link makes look like theirs. A stand-in helper keeps
// one OS user, which is exactly the case where only these checks stand in the way.
import assert from "node:assert/strict";
import { mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import test from "node:test";
import { cookieFrom, environment, startServer, stopServer, temporaryRoot } from "./queued-prompt-harness.js";

async function signIn(baseUrl: string, username: string, password: string): Promise<Record<string, string>> {
  const response = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
  assert.equal(response.status, 200, `${username} signs in`);
  const { csrfToken } = await response.json() as { csrfToken: string };
  return { Cookie: cookieFrom(response), "X-CSRF-Token": csrfToken, "Content-Type": "application/json" };
}

async function changePassword(baseUrl: string, headers: Record<string, string>, currentPassword: string, newPassword: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/auth/change-password`, { method: "POST", headers, body: JSON.stringify({ currentPassword, newPassword }) });
  assert.equal(response.status, 204);
}

test("a person's projects and transcripts are read only from their own home", { timeout: 120_000 }, async () => {
  const root = await temporaryRoot("jb-wall-paths-");
  const previous = { ...process.env };
  const homes = path.join(root, "homes");
  Object.assign(process.env, environment(root), {
    JOINT_BOB_USERCTL: path.resolve("test/fixtures/fake-userctl.sh"),
    JOINT_BOB_USERCTL_SUDO: "0",
    JOINT_BOB_ACCOUNT_HOME_ROOT: homes,
  });
  await mkdir(homes, { recursive: true });
  let server: Server | undefined;
  try {
    const { save, settingsDatabase } = await import("../src/settings-store.js");
    const { recordSelfTest } = await import("../src/multi-user.js");
    save(settingsDatabase(), "multiUser.enabled", "true");
    recordSelfTest(true, [], true);
    const started = await startServer();
    server = started.server;
    const baseUrl = started.baseUrl;
    const admin = await signIn(baseUrl, "admin", "initial-password");
    await changePassword(baseUrl, admin, "initial-password", "replacement-password");
    const created = await fetch(`${baseUrl}/api/users`, { method: "POST", headers: admin, body: JSON.stringify({ username: "dana", email: "dana@example.test" }) });
    assert.equal(created.status, 201);
    const { oneTimePassword } = await created.json() as { oneTimePassword: string };
    let dana = await signIn(baseUrl, "dana", oneTimePassword);
    await changePassword(baseUrl, dana, oneTimePassword, "dana-chosen-password-1");
    dana = await signIn(baseUrl, "dana", "dana-chosen-password-1");

    const danaHome = path.join(homes, "jb-dana");
    const adminHome = path.join(homes, "jb-admin");
    const add = (headers: Record<string, string>, name: string, folder: string) => fetch(`${baseUrl}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name, path: folder, type: headers === dana ? "dana--personal" : "personal" }) });
    for (const folder of [process.env.JOINT_BOB_DATA_DIR!, path.join(adminHome, "JointBob", "theirs"), path.join(root, "elsewhere")]) {
      await mkdir(folder, { recursive: true });
      assert.equal((await add(dana, "Not mine", folder)).status, 403, `a member can't add ${folder}`);
    }
    assert.equal((await add(admin, "Data", process.env.JOINT_BOB_DATA_DIR!)).status, 403, "nor can the admin add the service's data");
    const own = path.join(danaHome, "JointBob", "mine");
    await mkdir(own, { recursive: true });
    await writeFile(path.join(own, "notes.txt"), "dana's notes");
    const response = await add(dana, "Mine", own);
    assert.equal(response.status, 201, "a folder in their own home is fine");
    const { project } = await response.json() as { project: { id: string } };
    const file = await fetch(`${baseUrl}/api/projects/${project.id}/file?path=notes.txt`, { headers: dana });
    assert.equal(file.status, 200);

    // Swapping the folder for a link into someone else's home closes the project to the server.
    const theirs = path.join(adminHome, "JointBob", "secret");
    await mkdir(theirs, { recursive: true });
    await writeFile(path.join(theirs, "notes.txt"), "the admin's notes");
    await rename(own, `${own}-moved`);
    await symlink(theirs, own);
    const swapped = await fetch(`${baseUrl}/api/projects/${project.id}/file?path=notes.txt`, { headers: dana });
    assert.equal(swapped.status, 409, "the server won't follow the link out of their home");
    assert.doesNotMatch(await swapped.text(), /admin's notes/);
    await rm(own);
    await rename(`${own}-moved`, own);

    // A transcript folder linked to someone else's home lists nothing from there.
    const adminTranscripts = path.join(adminHome, ".claude", "projects", own.replace(/^\//, "-").replace(/[\s_./]+/g, "-"));
    await mkdir(adminTranscripts, { recursive: true });
    await writeFile(path.join(adminTranscripts, "4c1f1a2e-0000-4000-8000-000000000001.jsonl"), `${JSON.stringify({ type: "user", sessionId: "4c1f1a2e-0000-4000-8000-000000000001", cwd: own, timestamp: new Date().toISOString(), message: { role: "user", content: "the admin's private prompt" } })}\n`);
    await mkdir(path.join(danaHome, ".claude"), { recursive: true });
    await symlink(path.join(adminHome, ".claude", "projects"), path.join(danaHome, ".claude", "projects"));
    const sessions = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`, { headers: dana });
    assert.equal(sessions.status, 200);
    assert.doesNotMatch(await sessions.text(), /admin's private prompt|4c1f1a2e-0000-4000-8000-000000000001/, "a linked transcript folder is never read for them");
  } finally {
    await stopServer(server);
    process.env = previous;
    await rm(root, { recursive: true, force: true });
  }
});
