import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";

async function freshFiles() {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-dashboard-files-"));
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  return import(`../src/dashboards/files.js?files=${randomUUID()}`) as Promise<typeof import("../src/dashboards/files.js")>;
}

const manifest = (title: string) => JSON.stringify({ title, refresh: { method: "script", command: 'node "$JOINT_BOB_DASHBOARD_DIR/refresh.mjs"' } });

async function writeDraftFiles(directory: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), content);
  }
}

test("a saved draft becomes the live definition with a new digest; discard keeps the live one", async () => {
  const files = await freshFiles();
  const id = randomUUID();
  assert.equal(files.readLiveDefinition(id), undefined, "nothing is live before the first save");
  const draft = files.prepareDraft(id);
  await writeDraftFiles(draft, { "manifest.json": manifest("One"), "index.html": "<p>one</p>", "lib/refresh.mjs": "console.log('{}')" });
  const first = files.promoteDraft(id);
  const live = files.readLiveDefinition(id)!;
  assert.equal(live.digest, first.digest);
  assert.equal(live.manifest.title, "One");
  assert.equal(live.html, "<p>one</p>");
  assert.deepEqual(live.files.map((file) => file.path), ["index.html", "lib/refresh.mjs", "manifest.json"]);
  assert.equal(await readFile(path.join(live.directory, "lib/refresh.mjs"), "utf8"), "console.log('{}')");

  const again = files.prepareDraft(id);
  assert.equal(await readFile(path.join(again, "index.html"), "utf8"), "<p>one</p>", "an edit starts from the live definition");
  await writeFile(path.join(again, "index.html"), "<p>two</p>");
  assert.equal(files.draftExists(id), true);
  assert.equal(files.readDraftFiles(id).find((file) => file.path === "index.html")?.content.toString(), "<p>two</p>");
  files.discardDraft(id);
  assert.equal(files.draftExists(id), false);
  assert.equal(files.readLiveDefinition(id)!.html, "<p>one</p>");

  await writeDraftFiles(files.prepareDraft(id), { "index.html": "<p>two</p>" });
  const second = files.promoteDraft(id);
  assert.notEqual(second.digest, first.digest);
  assert.equal(files.readLiveDefinition(id)!.html, "<p>two</p>");
});

test("a draft without a valid manifest, with a symlink, or over the size limit is not saved", async () => {
  const files = await freshFiles();
  const id = randomUUID();
  const draft = files.prepareDraft(id);
  await writeDraftFiles(draft, { "index.html": "<p>x</p>" });
  assert.throws(() => files.promoteDraft(id), /manifest\.json/);
  await writeDraftFiles(draft, { "manifest.json": "{\"title\":\"x\"}" });
  assert.throws(() => files.promoteDraft(id), /manifest/);
  await writeDraftFiles(draft, { "manifest.json": manifest("ok") });
  await symlink("/etc/hosts", path.join(draft, "hosts"));
  assert.throws(() => files.promoteDraft(id), /link/);
  files.discardDraft(id);
  await writeDraftFiles(files.prepareDraft(id), { "manifest.json": manifest("ok"), "index.html": "x".repeat(5 * 1024 * 1024) });
  assert.throws(() => files.promoteDraft(id), /too large/);
  assert.equal(files.readLiveDefinition(id), undefined);
});

test("a received definition is written as given and keeps the owner's digest", async () => {
  const files = await freshFiles();
  const owner = randomUUID();
  await writeDraftFiles(files.prepareDraft(owner), { "manifest.json": manifest("Shared"), "index.html": "<p>s</p>" });
  const saved = files.promoteDraft(owner);
  const bundle = files.readLiveDefinition(owner)!.files;
  const copy = randomUUID();
  const written = files.writeReceivedDefinition(copy, bundle.map((file) => ({ path: file.path, content: file.content })));
  assert.equal(written.digest, saved.digest);
  assert.throws(() => files.writeReceivedDefinition(copy, [{ path: "../escape", content: Buffer.from("x") }, ...bundle]), /path/);
});

test("payloads, run logs and state stay per dashboard", async () => {
  const files = await freshFiles();
  const id = randomUUID();
  assert.equal(files.readPayload(id), undefined);
  files.writePayload(id, { generatedAt: "2026-10-24T09:00:00Z", n: 1 });
  assert.deepEqual(files.readPayload(id), { generatedAt: "2026-10-24T09:00:00Z", n: 1 });
  files.writeRunLog(id, "first");
  files.writeRunLog(id, "second");
  assert.equal(files.readRunLog(id), "second", "only the last run is kept");
  assert.match(files.stateDirectory(id), new RegExp(`${id}/state$`));
  files.removeDashboardFiles(id);
  assert.equal(files.readPayload(id), undefined);
  assert.throws(() => files.prepareDraft("../../etc"), /id/);
});
