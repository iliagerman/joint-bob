import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

interface GitHubGroup { id: string; label: string }

async function loadAuth(tag: string): Promise<Record<string, any>> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `joint-bob-github-groups-${tag}-`));
  process.env.PI_WEB_DATA_DIR = dataDir;
  delete process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH;
  return { dataDir, ...(await import(`../src/github-auth.js?groups=${tag}-${Date.now()}`)) };
}

test("groups are user defined, renaming keeps project assignments", async () => {
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  try {
    const auth = await loadAuth("rename");
    const work = (await auth.saveGitHubGroup({ label: "Work", token: "work-token" })) as GitHubGroup;
    const personal = (await auth.saveGitHubGroup({ label: "Personal", token: "personal-token" })) as GitHubGroup;
    assert.notEqual(work.id, personal.id);

    const groups = (await auth.listGitHubGroups()) as GitHubGroup[];
    assert.deepEqual(groups.map((group) => group.label).sort(), ["Personal", "Work"]);

    await auth.updateProjectGitHubAuth("project-a", work.id);
    assert.equal(auth.gitHubEnvironment("project-a").GH_TOKEN, "work-token");

    // Renaming the label must not break the assignment: the id is the stable key.
    const renamed = (await auth.saveGitHubGroup({ id: work.id, label: "Sela Work" })) as GitHubGroup;
    assert.equal(renamed.id, work.id);
    assert.equal(renamed.label, "Sela Work");
    assert.equal(auth.gitHubEnvironment("project-a").GH_TOKEN, "work-token");

    const status = await auth.getGitHubAuthStatus("project-a");
    assert.equal(status.project.group, work.id);
    assert.equal(status.project.configured, true);
    assert.equal(status.project.hasOverride, false);
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previousDataDir;
  }
});

test("deleting a group leaves its projects with no group", async () => {
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  try {
    const auth = await loadAuth("delete");
    const group = (await auth.saveGitHubGroup({ label: "Work", token: "work-token" })) as GitHubGroup;
    await auth.updateProjectGitHubAuth("project-a", group.id);
    assert.equal(auth.gitHubEnvironment("project-a").GH_TOKEN, "work-token");

    await auth.deleteGitHubGroup(group.id);
    assert.deepEqual(await auth.listGitHubGroups(), []);
    assert.deepEqual(auth.gitHubEnvironment("project-a"), {});


    const status = await auth.getGitHubAuthStatus("project-a");
    assert.equal(status.project.group, null);
    assert.equal(status.project.configured, false);
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previousDataDir;
  }
});

test("a project token override outranks its group token", async () => {
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  try {
    const auth = await loadAuth("override");
    const group = (await auth.saveGitHubGroup({ label: "Work", token: "work-token" })) as GitHubGroup;
    await auth.updateProjectGitHubAuth("project-a", group.id, "project-token");
    assert.equal(auth.gitHubEnvironment("project-a").GH_TOKEN, "project-token");

    const status = await auth.getGitHubAuthStatus("project-a");
    assert.equal(status.project.hasOverride, true);

    await auth.updateProjectGitHubAuth("project-a", group.id, null);
    assert.equal(auth.gitHubEnvironment("project-a").GH_TOKEN, "work-token");
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previousDataDir;
  }
});

test("a project with no group of its own falls back to the default group", async () => {
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  try {
    const auth = await loadAuth("nogroup");
    // The first group created becomes the default.
    const work = await auth.saveGitHubGroup({ label: "Work", token: "work-token" });
    assert.equal(work.isDefault, true);
    assert.equal(auth.gitHubEnvironment("unassigned-project").GH_TOKEN, "work-token");

    const personal = await auth.saveGitHubGroup({ label: "Personal", token: "personal-token", isDefault: true });
    assert.equal(personal.isDefault, true);
    assert.equal(auth.gitHubEnvironment("unassigned-project").GH_TOKEN, "personal-token");
    assert.deepEqual((await auth.listGitHubGroups()).filter((group: any) => group.isDefault).map((group: any) => group.id), [personal.id]);

    const status = await auth.getGitHubAuthStatus("unassigned-project");
    assert.equal(status.project.group, null);
    assert.equal(status.project.configured, true);
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previousDataDir;
  }
});

test("legacy personal and sela accounts migrate into labelled groups", async () => {
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousAuthPath = process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH;
  try {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-github-groups-legacy-"));
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      path.join(dataDir, "github-auth.json"),
      JSON.stringify({ accounts: { personal: "legacy-personal", sela: "legacy-sela" }, projects: { "project-a": { account: "sela" } } }),
    );
    process.env.PI_WEB_DATA_DIR = dataDir;
    delete process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH;
    const auth = await import(`../src/github-auth.js?groups=legacy-${Date.now()}`);

    const groups = (await auth.listGitHubGroups()) as GitHubGroup[];
    assert.deepEqual(groups.map((group) => group.label).sort(), ["Personal", "Sela"]);
    // Legacy ids are preserved so existing project rows and in-flight peer events still resolve.
    assert.deepEqual(groups.map((group) => group.id).sort(), ["personal", "sela"]);
    assert.equal(auth.gitHubEnvironment("project-a").GH_TOKEN, "legacy-sela");
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previousDataDir;
    if (previousAuthPath === undefined) delete process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH; else process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH = previousAuthPath;
  }
});

test("account credential events carry the group label and accept the legacy token-only shape", async () => {
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  try {
    const auth = await loadAuth("events");
    const group = (await auth.saveGitHubGroup({ label: "Work", token: "work-token" })) as GitHubGroup;
    await auth.enqueueGitHubCredentialSync(["11111111-1111-4111-8111-111111111111"]);
    const events = await auth.githubCredentialEventsForPeer("11111111-1111-4111-8111-111111111111");
    const accountEvent = events.find((event: any) => event.entityType === "account" && event.key === group.id);
    assert.deepEqual(accountEvent.value, { label: "Work", token: "work-token", isDefault: true });

    // A peer still running the old build sends a bare token string.
    await auth.receiveGitHubCredentialEvents([{
      id: "22222222-2222-4222-8222-222222222222",
      entityType: "account",
      key: "legacy-peer-group",
      operation: "upsert",
      value: "peer-token",
      updatedAt: new Date(Date.now() + 1000).toISOString(),
      originNodeId: "33333333-3333-4333-8333-333333333333",
      createdAt: new Date().toISOString(),
    }]);
    const merged = (await auth.listGitHubGroups()) as GitHubGroup[];
    assert.ok(merged.some((entry) => entry.id === "legacy-peer-group"));
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previousDataDir;
  }
});
