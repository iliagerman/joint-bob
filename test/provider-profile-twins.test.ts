import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";

interface Profile { id: string; label: string; provider: string; shared: boolean }
interface Selection { provider: string; scope: string; scopeId: string; profileId: string }
interface Listing { profiles: Profile[]; selections: Selection[] }
const TOKEN_PATH = "/api/cluster/v2/twins/provider-profiles/token";

async function until(check: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 40_000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}
async function listing(node: SeededNode, session: SignedIn): Promise<Listing> {
  const response = await api<Listing>(node, session, "GET", "/provider-profiles");
  assert.equal(response.status, 200);
  return response.body;
}
async function signIntoProfile(node: SeededNode, profileId: string, access: string): Promise<string> {
  const file = path.join(node.dataDir, "provider-profile-auth", profileId, "auth.json");
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify({ "openai-codex": { type: "oauth", access, refresh: `${access}-refresh`, expires: Date.now() + 3_600_000, accountId: `${access}-account` } }), { mode: 0o600 });
  return file;
}
/** A request signed with `sender`'s own node key, as a twin's borrowing request is. */
function signed(environment: DevEnvironment, sender: SeededNode, recipient: SeededNode, body: string): string {
  return execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { DatabaseSync } from "node:sqlite";
    import { signClusterRequest } from "./src/cluster-protocol.ts";
    const db = new DatabaseSync(process.env.JOINT_BOB_DATA_DIR + "/node.db");
    process.stdout.write(signClusterRequest(db, ${JSON.stringify(sender.nodeId)}, ${JSON.stringify(recipient.nodeId)}, "POST", ${JSON.stringify(TOKEN_PATH)}, Buffer.from(${JSON.stringify(body)})));
    db.close();
  `], { env: { ...process.env, HOME: environment.home, JOINT_BOB_DATA_DIR: sender.dataDir }, encoding: "utf8" });
}

test("twins receive subscription profiles and choices, and borrow tokens from the node holding the sign-in", { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "provider-profile-twins-"));
  const environment = await seedDevEnvironment(root, 2), [a, b] = environment.nodes;
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    for (const node of environment.nodes) children.push(await startDevNode(environment, node));
    await pairTwinNodes(environment);
    const sa = await signIn(environment, a), sb = await signIn(environment, b);
    const created = await api<{ profile: Profile }>(a, sa, "POST", "/provider-profiles", { provider: "openai-codex", label: "Work" });
    assert.equal(created.status, 201);
    const id = created.body.profile.id;
    const workspaces = await api<{ workspaces: Array<{ id: string }> }>(a, sa, "GET", "/workspaces");
    const choices = [{ scope: "default", scopeId: "" }, ...workspaces.body.workspaces.map((workspace) => ({ scope: "workspace", scopeId: workspace.id }))];
    for (const choice of choices) assert.equal((await api(a, sa, "PUT", "/provider-profiles/selection", { provider: "openai-codex", ...choice, profileId: id })).status, 200);

    await t.test("the profile and every scope choice reach the twin without setting them there", async () => {
      await until(async () => {
        const body = await listing(b, sb);
        return body.profiles.some((profile) => profile.id === id && profile.label === "Work") && body.selections.filter((selection) => selection.profileId === id).length === choices.length;
      }, "twin must list the profile and all its choices");
    });

    await t.test("a twin without its own sign-in reports the node it borrows from", async () => {
      const before = await api<{ signedIn: boolean; twin: string | null }>(b, sb, "GET", `/provider-profiles/${id}/status`);
      assert.deepEqual([before.body.signedIn, before.body.twin], [false, null]);
      await signIntoProfile(a, id, "lent");
      const after = await api<{ signedIn: boolean; twin: string | null; message: string }>(b, sb, "GET", `/provider-profiles/${id}/status`);
      assert.equal(after.status, 200);
      assert.deepEqual([after.body.signedIn, after.body.twin], [false, a.name]);
      assert.match(after.body.message, new RegExp(`sign-in on ${a.name}`));
    });

    await t.test("the holding node lends only the access token, and only to its twin", async () => {
      const body = JSON.stringify({ profileId: id });
      const lent = await fetch(`${a.url}${TOKEN_PATH}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: signed(environment, b, a, body) }, body });
      assert.equal(lent.status, 200);
      const text = await lent.text();
      assert.doesNotMatch(text, /lent-refresh/);
      const { credential } = JSON.parse(text) as { credential: { access: string; refresh: string; accountId: string } };
      assert.deepEqual([credential.access, credential.refresh, credential.accountId], ["lent", "", "lent-account"]);
      const unsigned = await fetch(`${a.url}${TOKEN_PATH}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      assert.equal(unsigned.status, 401);
    });

    await t.test("clearing choices and deleting the profile propagate, removing the twin's own sign-in", async () => {
      const twinLogin = await signIntoProfile(b, id, "own");
      for (const choice of choices) assert.equal((await api(a, sa, "PUT", "/provider-profiles/selection", { provider: "openai-codex", ...choice, profileId: null })).status, 200);
      await until(async () => (await listing(b, sb)).selections.length === 0, "cleared choices must reach the twin");
      assert.equal((await api(a, sa, "DELETE", `/provider-profiles/${id}`)).status, 200);
      await until(async () => (await listing(b, sb)).profiles.length === 0, "deletion must reach the twin");
      await assert.rejects(stat(twinLogin), { code: "ENOENT" });
    });
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
