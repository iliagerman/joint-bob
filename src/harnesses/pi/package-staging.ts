import { randomUUID } from "node:crypto";
import { chmod, cp, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { readInstalledPiPackages, type PiExtensionPackage } from "./resource-loader.js";

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function copyRoot(source: string, target: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
}

export async function stageInstalledPiPackages(sourceAgentDir: string, targetAgentDir: string): Promise<void> {
  const packages = readInstalledPiPackages(path.join(sourceAgentDir, "settings.json"));
  const manager = new DefaultPackageManager({
    cwd: sourceAgentDir,
    agentDir: sourceAgentDir,
    settingsManager: SettingsManager.create(sourceAgentDir, sourceAgentDir, { projectTrusted: false }),
  });
  const copyRoots = new Map<string, string>();
  const staged: PiExtensionPackage[] = [];
  const sourceNpm = path.join(sourceAgentDir, "npm");
  const sourceGit = path.join(sourceAgentDir, "git");
  const targetNpm = path.join(targetAgentDir, "npm");
  const targetGit = path.join(targetAgentDir, "git");

  for (const [index, declaration] of packages.entries()) {
    const installed = manager.getInstalledPath(declaration.source, "user");
    if (!installed) throw new Error("A configured Pi package is not installed");
    if (contains(sourceNpm, installed)) {
      copyRoots.set(sourceNpm, targetNpm);
      staged.push({ ...declaration, source: path.join(targetNpm, path.relative(sourceNpm, installed)) });
    } else if (contains(sourceGit, installed)) {
      copyRoots.set(sourceGit, targetGit);
      staged.push({ ...declaration, source: path.join(targetGit, path.relative(sourceGit, installed)) });
    } else if (declaration.source.startsWith("npm:") && path.basename(path.dirname(installed)) === "node_modules") {
      const sourceModules = path.dirname(installed);
      const targetModules = path.join(targetNpm, "node_modules");
      copyRoots.set(sourceModules, targetModules);
      staged.push({ ...declaration, source: path.join(targetModules, path.relative(sourceModules, installed)) });
    } else {
      const target = path.join(targetAgentDir, "installed-packages", String(index));
      await copyRoot(installed, target);
      staged.push({ ...declaration, source: target });
    }
  }

  for (const [source, target] of copyRoots) await copyRoot(source, target);
  await mkdir(targetAgentDir, { recursive: true });
  const settingsPath = path.join(targetAgentDir, "settings.json");
  const temporarySettingsPath = `${settingsPath}.${randomUUID()}.tmp`;
  await writeFile(temporarySettingsPath, JSON.stringify({ packages: staged }), { mode: 0o660 });
  await chmod(temporarySettingsPath, 0o660);
  await rename(temporarySettingsPath, settingsPath);
}
