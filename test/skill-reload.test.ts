import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function writeSkill(root: string, name: string, description: string): Promise<void> {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`);
}

test("real Pi sessions reload shared and configured skills without losing session state", async () => {
  const cwd = path.join(os.homedir(), "reload-project");
  const extraRoot = path.join(os.homedir(), "extra-skills");
  const { agentResourcePaths } = await import("../src/agent-resources.js");
  const { getSettings, updateProjectResourcePaths } = await import("../src/settings.js");
  const { addProject, removeProject } = await import("../src/store.js");
  const { createPiSession, reloadPiSkills } = await import("../src/pi-service.js");
  const shared = agentResourcePaths().sharedSkills;
  const native = path.join(getSettings().pi.configPath, "skills");
  let project: Awaited<ReturnType<typeof addProject>> | undefined;
  let handle: Awaited<ReturnType<typeof createPiSession>> | undefined;
  try {
    await mkdir(cwd, { recursive: true });
    await writeSkill(native, "review", "stale native");
    await writeSkill(shared, "review", "shared first");
    project = await addProject("Reload test", cwd, { writeInstructions: false });
    handle = await createPiSession({ cwd, projectId: project.id });
    handle.session.setActiveToolsByName(["read"]);
    const initial = { sessionId: handle.session.sessionId, model: handle.session.model, messages: handle.session.messages };
    assert.equal(handle.session.resourceLoader.getSkills().skills.find((skill) => skill.name === "review")?.description, "shared first");
    assert.match(handle.session.agent.state.systemPrompt, /shared first/);

    await writeSkill(shared, "review", "shared second");
    await reloadPiSkills(handle);
    assert.equal(handle.session.resourceLoader.getSkills().skills.find((skill) => skill.name === "review")?.description, "shared second");
    assert.match(handle.session.agent.state.systemPrompt, /shared second/);
    assert.equal(handle.session.sessionId, initial.sessionId);
    assert.equal(handle.session.model, initial.model);
    assert.deepEqual(handle.session.messages, initial.messages);
    assert.deepEqual(handle.session.getActiveToolNames(), ["read"]);

    await writeSkill(extraRoot, "extra", "configured extra");
    updateProjectResourcePaths(project.id, { skills: [extraRoot], prompts: [], rules: [], plugins: [] });
    await reloadPiSkills(handle);
    assert.ok(handle.session.resourceLoader.getSkills().skills.some((skill) => skill.name === "extra"));
    updateProjectResourcePaths(project.id, { skills: [], prompts: [], rules: [], plugins: [] });
    await reloadPiSkills(handle);
    assert.equal(handle.session.resourceLoader.getSkills().skills.some((skill) => skill.name === "extra"), false);
  } finally {
    handle?.dispose();
    if (project) await removeProject(project.id);
    await rm(cwd, { recursive: true, force: true });
    await rm(extraRoot, { recursive: true, force: true });
    await rm(path.join(native, "review"), { recursive: true, force: true });
    await rm(path.join(shared, "review"), { recursive: true, force: true });
  }
});

test("reloadPiSkills rejects busy and serializes concurrent reloads while restoring tools", async () => {
  const { reloadPiSkills } = await import("../src/pi-service.js") as typeof import("../src/pi-service.js") & { reloadPiSkills: (handle: any) => Promise<void> };
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const active: string[][] = [];
  const handle: any = {
    safeguardsEnabled: true,
    dispose() {},
    session: {
      isStreaming: false, isBashRunning: false, isCompacting: false, isRetrying: false,
      getActiveToolNames: () => ["read"], getAllTools: () => [{ name: "read" }, { name: "write" }],
      setActiveToolsByName: (names: string[]) => active.push(names), reload: () => pending,
    },
  };
  const first = reloadPiSkills(handle);
  assert.equal(handle.reloadingSkills, true);
  await assert.rejects(reloadPiSkills(handle), /busy/i);
  release(); await first;
  assert.equal(handle.reloadingSkills, false);
  assert.deepEqual(active, [["read"]]);
  handle.session.reload = async () => { throw new Error("reload failed"); };
  await assert.rejects(reloadPiSkills(handle), /reload failed/);
  assert.equal(handle.reloadingSkills, false);
});
