import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode, type SignedIn } from "./dev-nodes.js";

interface Command { id: string; name: string; prompt: string; kind: string }
interface Catalog { commands: Command[]; recentIds?: string[] }

async function catalog(node: SeededNode, session: SignedIn): Promise<Command[]> {
  const response = await api<Catalog>(node, session, "GET", "/commands/sharing");
  assert.equal(response.status, 200);
  return response.body.commands;
}

async function memberSession(node: SeededNode, admin: SignedIn): Promise<SignedIn> {
  const created = await api<{ oneTimePassword: string }>(node, admin, "POST", "/users", { username: "bea", email: "bea@example.test" });
  assert.equal(created.status, 201);
  const login = await fetch(`${node.url}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "bea", password: created.body.oneTimePassword }) });
  assert.equal(login.status, 200);
  const session = { cookie: login.headers.get("set-cookie")!.split(";")[0], csrfToken: (await login.json() as { csrfToken: string }).csrfToken };
  const changed = await fetch(`${node.url}/api/auth/change-password`, { method: "POST", headers: { Cookie: session.cookie, "x-csrf-token": session.csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: created.body.oneTimePassword, newPassword: "synthetic-command-twins-password" }) });
  assert.equal(changed.status, 204);
  return session;
}

test("twins automatically share existing and new commands without settings changes", { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "commands-twins-"));
  const env = await seedDevEnvironment(root, 2), [a, b] = env.nodes;
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    for (const node of env.nodes) children.push(await startDevNode(env, node, { JOINT_BOB_TEST_MULTI_USER_READY: "1" }));
    const sa = await signIn(env, a), sb = await signIn(env, b);
    const created = await api<{ command: Command }>(a, sa, "POST", "/commands", { name: "Existing", prompt: "Saved before pairing" });
    assert.equal(created.status, 200);
    const relationshipId = await pairTwinNodes(env);
    // Pairing canonicalizes the account ID. The preset itself keeps its identity.
    const local = (await catalog(a, sa)).find((command) => command.name === "Existing")!;
    assert.equal(local.id.split("/").at(-1), created.body.command.id.split("/").at(-1));
    await t.test("pairing exposes existing commands without a cluster or a sharing policy", async () => {
      assert.deepEqual((await catalog(b, sb)).map(({ id, prompt, kind }) => ({ id, prompt, kind })), [{ id: local.id, prompt: "Saved before pairing", kind: "received" }]);
      const used = await api(b, sb, "POST", `/commands/${encodeURIComponent(local.id)}/use`, { projectId: a.projects[0].id });
      assert.equal(used.status, 200);
      const picker = await api<Catalog>(b, sb, "GET", `/commands?projectId=${a.projects[0].id}`);
      assert.equal(picker.status, 200);
      assert.equal(picker.body.commands[0]?.id, local.id);
      assert.deepEqual(picker.body.recentIds, [local.id]);
      assert.equal((await api(b, sb, "PUT", `/commands/${encodeURIComponent(local.id)}/sharing`, {})).status, 403, "received commands remain read-only");
    });
    await t.test("new commands share in both directions", async () => {
      for (const [node, session, peer, peerSession] of [[a, sa, b, sb], [b, sb, a, sa]] as const) {
        const saved = await api<{ command: Command }>(node, session, "POST", "/commands", { name: `New on ${node.key}`, prompt: `From ${node.key}` });
        assert.equal(saved.status, 200);
        const remote = (await catalog(peer, peerSession)).filter((command) => command.id === saved.body.command.id);
        assert.equal(remote.length, 1);
        assert.equal(remote[0].prompt, `From ${node.key}`);
      }
    });
    await t.test("member commands do not leave their account or receive the administrator's twin commands", async () => {
      const member = await memberSession(b, sb);
      assert.equal((await api(b, member, "POST", "/commands", { name: "Member private", prompt: "Member only" })).status, 200);
      assert.deepEqual((await catalog(b, member)).map((command) => command.prompt), ["Member only"]);
      assert.equal((await catalog(a, sa)).some((command) => command.prompt === "Member only"), false);
    });
    await t.test("edits and deletion propagate without a share or refresh action", async () => {
      const response = await api<{ conversationCommands: { start: unknown; end: unknown; presets: Array<{ id: string; name: string; prompt: string }> } }>(a, sa, "GET", "/settings");
      const settings = response.body.conversationCommands;
      settings.presets.find((command) => command.name === "Existing")!.prompt = "Edited on owner";
      assert.equal((await api(a, sa, "PUT", "/settings/personal", { conversationCommands: settings })).status, 200);
      assert.equal((await catalog(b, sb)).find((command) => command.id === local.id)?.prompt, "Edited on owner");
      settings.presets = settings.presets.filter((command) => command.name !== "Existing");
      assert.equal((await api(a, sa, "PUT", "/settings/personal", { conversationCommands: settings })).status, 200);
      assert.equal((await catalog(b, sb)).some((command) => command.id === local.id), false);
      assert.equal((await api(b, sb, "POST", `/commands/${encodeURIComponent(local.id)}/use`, { projectId: a.projects[0].id })).status, 404);
    });
    await t.test("background sync catches missed creates, edits and deletions without opening a picker", async () => {
      assert.equal((await api(a, sa, "POST", "/commands", { name: "Deleted while away", prompt: "Remove this copy" })).status, 200);
      await stopDevNode(children[1]);
      const response = await api<{ conversationCommands: { presets: Array<{ id: string; name: string; prompt: string }> } }>(a, sa, "GET", "/settings");
      const settings = response.body.conversationCommands;
      settings.presets = settings.presets.filter((command) => command.name !== "Deleted while away");
      settings.presets.find((command) => command.name === `New on ${a.key}`)!.prompt = "Edited while receiver sleeps";
      assert.equal((await api(a, sa, "PUT", "/settings/personal", { conversationCommands: settings })).status, 200);
      assert.equal((await api(a, sa, "POST", "/commands", { name: "Created while away", prompt: "Missed notification" })).status, 200);
      children[1] = await startDevNode(env, b, { JOINT_BOB_TEST_MULTI_USER_READY: "1" });
      const db = new DatabaseSync(path.join(b.dataDir, "node.db"));
      try {
        const deadline = Date.now() + 40_000;
        for (;;) {
          const row = db.prepare("SELECT payload FROM received_command_snapshots WHERE owner_node_id=?").get(a.nodeId) as { payload: string };
          const commands = JSON.parse(row.payload).commands as Command[];
          if (commands.some((command) => command.name === "Created while away") && commands.some((command) => command.prompt === "Edited while receiver sleeps") && !commands.some((command) => command.name === "Deleted while away")) break;
          assert.ok(Date.now() < deadline, "background sync must catch up without a command API read");
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } finally { db.close(); }
      await stopDevNode(children[0]);
      const received = await catalog(b, sb);
      assert.equal(received.some((command) => command.prompt === "Edited while receiver sleeps"), true);
      assert.equal(received.some((command) => command.name === "Deleted while away"), false);
      children[0] = await startDevNode(env, a, { JOINT_BOB_TEST_MULTI_USER_READY: "1" });
    });
    await t.test("commands sync before the picker opens and survive an offline owner and receiver restart", async () => {
      const saved = await api<{ command: Command }>(a, sa, "POST", "/commands", { name: "Offline twin", prompt: "Available while Mac sleeps" });
      assert.equal(saved.status, 200);
      await stopDevNode(children[0]);
      await stopDevNode(children[1]);
      children[1] = await startDevNode(env, b, { JOINT_BOB_TEST_MULTI_USER_READY: "1" });
      assert.equal((await catalog(b, sb)).find((command) => command.id === saved.body.command.id)?.prompt, "Available while Mac sleeps");
      assert.equal((await api(b, sb, "POST", `/commands/${encodeURIComponent(saved.body.command.id)}/use`, { projectId: a.projects[0].id })).status, 200);
      children[0] = await startDevNode(env, a, { JOINT_BOB_TEST_MULTI_USER_READY: "1" });
      assert.equal((await catalog(b, sb)).filter((command) => command.id === saved.body.command.id).length, 1);
    });
    await t.test("unpairing removes automatic commands immediately", async () => {
      await stopDevNode(children[0]);
      assert.equal((await api(b, sb, "DELETE", `/twins/${relationshipId}`)).status, 200);
      assert.equal((await catalog(b, sb)).some((command) => command.kind === "received"), false);
    });
  } finally { await Promise.all(children.map(stopDevNode)); await rm(root, { recursive: true, force: true }); }
});
