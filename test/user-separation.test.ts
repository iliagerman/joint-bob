// The wall between people on one node, at the places a sweep of plain route calls can't
// reach: a differently spelled admin route, a request forwarded to another node, an id
// passed in the body, and what a person's processes inherit from the service.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runtimeEnvironment } from "../src/account-runtime.js";
import { isAdminRoute } from "../src/server/admin.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode, type SignedIn } from "./dev-nodes.js";

async function memberSession(node: SeededNode, username: string, oneTimePassword: string): Promise<SignedIn> {
  const login = await fetch(`${node.url}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password: oneTimePassword }) });
  const body = await login.json() as { csrfToken: string };
  const session = { cookie: login.headers.get("set-cookie")!.split(";")[0], csrfToken: body.csrfToken };
  const changed = await fetch(`${node.url}/api/auth/change-password`, { method: "POST", headers: { Cookie: session.cookie, "x-csrf-token": session.csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: oneTimePassword, newPassword: "member-chosen-password-1" }) });
  assert.equal(changed.status, 204);
  return session;
}

/** A call by its exact path, which `api()` would normalise. */
async function raw(node: SeededNode, session: SignedIn, method: string, target: string, body?: unknown): Promise<{ status: number; text: string }> {
  const response = await fetch(`${node.url}${target}`, {
    method, headers: { Cookie: session.cookie, "x-csrf-token": session.csrfToken, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, text: await response.text() };
}

test("the admin gate matches a route however its path is spelled", () => {
  for (const [method, route] of [
    ["GET", "/Users"], ["GET", "/users/"], ["POST", "/USERS/abc/admin-transfer"], ["PUT", "/settings/"], ["PUT", "/Settings"],
    ["GET", "/audit/"], ["POST", "/Update/install"], ["GET", "/Twins"], ["PUT", "/Multi-user/claude-token"], ["PUT", "/terminal-policy/"],
    ["PUT", "/cluster/node/"], ["PUT", "/browser/config//"], ["POST", "/resources/mcp/share"], ["DELETE", "/resources/skills/anything"], ["GET", "/resources/skills/sharing"],
  ] as const) assert.equal(isAdminRoute(method, route), true, `${method} ${route} is the admin's`);
  for (const [method, route] of [["GET", "/settings"], ["GET", "/projects"], ["GET", "/account/admin-transfer"], ["GET", "/resources/mcp"]] as const) {
    assert.equal(isAdminRoute(method, route), false, `${method} ${route} is everyone's`);
  }
});

test("a person's processes inherit none of the service's keys, tokens or passwords", () => {
  const runtime = { key: "account:test", name: "jb-test", home: "/home/jb-test" };
  const inherited = { JOINT_BOB_SECRET_KEY: "at-rest-key", JOINT_BOB_INITIAL_PASSWORD: "first", JOINT_BOB_SYNCTHING_API_KEY: "sync", GH_TOKEN: "service-gh", AWS_SECRET_ACCESS_KEY: "aws", SOME_ADMIN_VARIABLE: "x", JOINT_BOB_PLAIN_SETTING: "kept", LANG: "en_US.UTF-8" };
  const before = { ...process.env };
  Object.assign(process.env, inherited);
  try {
    const result = runtimeEnvironment(runtime, { ...process.env, GH_TOKEN: "this-run-token", RUN_SECRET_VALUE: "for-this-run", JOINT_BOB_DATA_DIR: "/service/data" });
    for (const name of ["JOINT_BOB_SECRET_KEY", "JOINT_BOB_INITIAL_PASSWORD", "JOINT_BOB_SYNCTHING_API_KEY", "AWS_SECRET_ACCESS_KEY", "SOME_ADMIN_VARIABLE", "JOINT_BOB_DATA_DIR"]) {
      assert.equal(result[name], undefined, `${name} stays with the service`);
    }
    assert.equal(result.GH_TOKEN, "this-run-token", "a value set for this run is the person's own");
    assert.equal(result.RUN_SECRET_VALUE, "for-this-run");
    assert.equal(result.JOINT_BOB_PLAIN_SETTING, "kept");
    assert.equal(result.LANG, "en_US.UTF-8");
    assert.equal(result.PATH, process.env.PATH);
    assert.equal(result.HOME, "/home/jb-test");
    assert.equal(result.TMPDIR, "/home/jb-test/.tmp");
  } finally {
    for (const name of Object.keys(inherited)) if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name];
  }
});

test("a member reaches nobody else's things by another spelling, another node or another id", { timeout: 300_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "user-separation-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const child = await startDevNode(environment, node, { JOINT_BOB_TEST_MULTI_USER_READY: "1" });
  try {
    const admin = await signIn(environment, node);
    const adminProject = node.projects[0];
    const sessions = await api<{ sessions: Array<{ id: string; harnessId?: string; engine?: string; title?: string }> }>(node, admin, "GET", `/projects/${adminProject.id}/sessions`);
    const adminSession = sessions.body.sessions[0];
    assert.ok(adminSession, "the seeded project has a conversation");
    const engine = adminSession.harnessId ?? adminSession.engine ?? "pi";
    const secret = await api<{ account: { id: string } }>(node, admin, "POST", "/secrets/accounts", { label: "Admin Only", provider: "custom", replicate: false, variables: [{ name: "ADMIN_ONLY", kind: "value", value: "admin-secret-value" }] });
    assert.equal(secret.status, 201, JSON.stringify(secret.body));

    const people: Record<string, { session: SignedIn; userId: string; projectId: string }> = {};
    for (const name of ["bea", "cal"]) {
      const created = await api<{ user: { userId: string }; oneTimePassword: string }>(node, admin, "POST", "/users", { username: name, email: `${name}@example.test` });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const session = await memberSession(node, name, created.body.oneTimePassword);
      const folder = path.join(root, `${name}-project`);
      await mkdir(folder, { recursive: true });
      const project = await api<{ project: { id: string } }>(node, session, "POST", "/projects", { name: `${name} project`, path: folder, type: `${name}--personal` });
      assert.equal(project.status, 201, JSON.stringify(project.body));
      people[name] = { session, userId: created.body.userId, projectId: project.body.project.id };
    }
    const { bea, cal } = people;
    assert.equal((await api(node, admin, "POST", "/users", { username: "bea-", email: "other@example.test" })).status, 409, "a username that comes to the same OS account is refused");

    // Admin routes, spelled the way Express also accepts them.
    for (const [method, target, body] of [
      ["GET", "/api/Users", undefined], ["GET", "/api/users/", undefined], ["GET", "/API/USERS", undefined],
      ["POST", `/api/Users/${bea.userId}/admin-transfer`, {}], ["PUT", "/api/settings/", {}], ["GET", "/api/audit/", undefined],
      ["GET", "/api/Twins", undefined], ["PUT", "/api/terminal-policy/", {}], ["GET", "/api/resources/skills/sharing", undefined],
      ["POST", "/api/resources/mcp/share", { file: "/tmp/x.json", names: ["x"] }],
    ] as const) {
      const answer = await raw(node, bea.session, method, target, body);
      assert.equal(answer.status, 404, `${method} ${target} answers a member like an unknown route, not ${answer.status}: ${answer.text.slice(0, 200)}`);
      assert.equal(/bea@|cal@|admin/i.test(answer.text.replace(/"error":"Not found"/, "")), false, `${method} ${target} names nobody`);
    }
    assert.equal((await api<{ offered: boolean }>(node, bea.session, "GET", "/account/admin-transfer")).body.offered, false, "no admin role was offered by a member");
    assert.equal((await api(node, bea.session, "POST", "/account/admin-transfer/accept", {})).status, 404);

    // Someone else's project answers 404 before a request can be forwarded to another node.
    for (const other of [adminProject.id, cal.projectId]) {
      for (const [method, target] of [
        ["GET", `/projects/${other}/file?path=README.md&nodeId=some-other-node`], ["GET", `/projects/${other}/files?nodeId=some-other-node`],
        ["GET", `/projects/${other}/file-content?path=README.md&nodeId=some-other-node`], ["POST", `/projects/${other}/file-delete?path=README.md&nodeId=some-other-node`],
        ["GET", `/projects/${other}/git/status?nodeId=some-other-node`], ["POST", `/projects/${other}/git/ask?nodeId=some-other-node`],
        ["GET", `/projects/${other}/sessions`], ["GET", `/browser/sessions?projectId=${other}&engine=pi&conversationId=x`],
      ] as const) {
        const answer = await api<{ error?: string }>(node, bea.session, method, target, method === "GET" ? undefined : {});
        assert.equal(answer.status, 404, `${method} ${target} -> ${answer.status} ${JSON.stringify(answer.body)}`);
        assert.equal(answer.body.error, "Project not found", `${method} ${target} answers as for a project that doesn't exist`);
      }
    }
    assert.equal((await api(node, bea.session, "POST", "/push/subscribe", { subscription: { endpoint: "https://push.example.test/x", keys: { p256dh: "a", auth: "b" } }, projectId: adminProject.id, sessionPath: "*", title: "x" })).status, 404, "no notifications for a project a person can't open");

    // A conversation of another project can't be renamed, recoloured or closed from one's own.
    for (const [action, body] of [
      ["title", { title: "taken over" }], ["done", { done: true }], ["color", { color: "red" }], ["classification", { classification: "bug" }],
    ] as const) {
      const answer = await api(node, bea.session, "PUT", `/projects/${bea.projectId}/sessions/${action}`, { engine, sessionId: adminSession.id, ...body });
      assert.ok([400, 404].includes(answer.status), `sessions/${action} with another project's conversation -> ${answer.status}`);
    }
    const after = await api<{ sessions: Array<{ id: string; title?: string; done?: boolean }> }>(node, admin, "GET", `/projects/${adminProject.id}/sessions`);
    const unchanged = after.body.sessions.find((entry) => entry.id === adminSession.id);
    assert.equal(unchanged?.title, adminSession.title, "the admin's conversation keeps its name");
    assert.notEqual(unchanged?.done, true, "and stays open");

    // Another person's secret: not shared, not read, not attached to a note for a later launch.
    assert.equal((await api(node, bea.session, "GET", `/secrets/accounts/${secret.body.account.id}/sharing`)).status, 404);
    assert.equal((await api(node, bea.session, "PUT", `/secrets/accounts/${secret.body.account.id}/sharing`, { grants: [] })).status, 404);
    const note = await api(node, bea.session, "POST", "/quick-notes", { projectId: bea.projectId, title: "later", content: "use it", harnessId: "pi", secretAccountIds: [secret.body.account.id] });
    assert.equal(note.status, 404, `a note can't carry someone else's secret: ${JSON.stringify(note.body)}`);

    // Each person keeps their own; nobody lost anything.
    for (const [name, person] of Object.entries(people)) {
      const listed = await api<{ projects: Array<{ id: string }> }>(node, person.session, "GET", "/projects?syncStatus=false");
      assert.deepEqual(listed.body.projects.map((project) => project.id), [person.projectId], `${name} lists only their own project`);
    }
    const users = await api<{ users: Array<{ username: string; role: string }> }>(node, admin, "GET", "/users");
    assert.equal(users.body.users.filter((user) => user.role === "admin").length, 1, "the node still has its one admin");
  } finally {
    await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});

test("the browser starts as a person's account and keeps its profile in their home", { timeout: 120_000 }, async (context) => {
  const { accountLaunch, browserCapability } = await import("../src/browser-runtime.js");
  const { prepareProfile } = await import("../src/browser-profile-files.js");
  const capability = await browserCapability();
  if (!capability.executable) { context.skip("no browser is installed on this machine"); return; }
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-account-"));
  const before = { helper: process.env.JOINT_BOB_USERCTL, sudo: process.env.JOINT_BOB_USERCTL_SUDO, homes: process.env.JOINT_BOB_ACCOUNT_HOME_ROOT, data: process.env.JOINT_BOB_DATA_DIR };
  Object.assign(process.env, { JOINT_BOB_USERCTL: path.resolve("test/fixtures/fake-userctl.sh"), JOINT_BOB_USERCTL_SUDO: "0", JOINT_BOB_ACCOUNT_HOME_ROOT: path.join(root, "homes"), JOINT_BOB_DATA_DIR: path.join(root, "data") });
  try {
    const runtime = { key: "account:dana", name: "dana", home: path.join(root, "homes", "jb-dana") };
    await mkdir(runtime.home, { recursive: true });
    const profileId = "11111111-1111-4111-8111-111111111111";
    // A profile from before the person had an account moves into their home.
    const old = path.join(root, "data", "browser", "profiles", profileId, "Default");
    await mkdir(old, { recursive: true });
    await writeFile(path.join(old, "marker"), "kept");
    const directory = await prepareProfile(profileId, runtime);
    assert.equal(directory, path.join(runtime.home, ".joint-bob-browser", "profiles", profileId));
    assert.equal(await readFile(path.join(directory, "Default", "marker"), "utf8"), "kept", "its logins came along");
    await assert.rejects(stat(path.join(root, "data", "browser", "profiles", profileId)), "and left the service's data");

    const { chromium } = await import("playwright-core");
    const browser = await chromium.launchPersistentContext(directory, { ...accountLaunch(runtime, capability.executable), headless: true });
    try {
      const page = browser.pages()[0] ?? await browser.newPage();
      await page.goto("data:text/html,<title>as the account</title>");
      assert.equal(await page.title(), "as the account", "Playwright drives the browser through the account helper");
    } finally { await browser.close(); }
    assert.match(await readFile(path.join(root, "homes", "runs.log"), "utf8"), /^dana$/m, "the browser ran through the helper, as the account");

    // A browser folder swapped for a link out of the home is refused.
    const other = { key: "account:eve", name: "eve", home: path.join(root, "homes", "jb-eve") };
    await mkdir(other.home, { recursive: true });
    await symlink(path.join(root, "data"), path.join(other.home, ".joint-bob-browser"));
    await assert.rejects(prepareProfile(profileId, other), /is a link/);
  } finally {
    for (const [name, value] of [["JOINT_BOB_USERCTL", before.helper], ["JOINT_BOB_USERCTL_SUDO", before.sudo], ["JOINT_BOB_ACCOUNT_HOME_ROOT", before.homes], ["JOINT_BOB_DATA_DIR", before.data]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
