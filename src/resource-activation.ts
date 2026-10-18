import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { agentResourcePaths } from "./agent-resources.js";
import { parse as parseYaml } from "yaml";
import { resolveDataDirectory } from "./data-directory.js";
import { settingsDatabase, value } from "./settings-store.js";
import { relaySkillDirective, relayPolicySubscriptions } from "./relay/resource-policy.js";
import type { HarnessId } from "./types.js";

export type ActivatableResource = "skill" | "plugin" | "mcp";
export type ActivationDecision = { enabled: boolean; reason: string; preference: boolean | null; shared: boolean };

function schema(): void {
  settingsDatabase().exec(`CREATE TABLE IF NOT EXISTS resource_activation (
    kind TEXT NOT NULL CHECK(kind IN ('skill','plugin','mcp')),
    name TEXT NOT NULL,
    harness TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    PRIMARY KEY(kind,name,harness)
  ); CREATE TABLE IF NOT EXISTS received_resource_activation (
    kind TEXT NOT NULL CHECK(kind IN ('plugin','mcp')),
    name TEXT NOT NULL,
    PRIMARY KEY(kind,name)
  )`);
}

/** Local choices outrank the node-wide default and survive updates and reconnection. */
export function activationPreference(kind: ActivatableResource, name: string, harness: HarnessId): boolean | null {
  schema();
  const row = settingsDatabase().prepare("SELECT enabled FROM resource_activation WHERE kind=? AND name=? AND harness=?")
    .get(kind, name, harness) as { enabled: number } | undefined;
  return row ? Boolean(row.enabled) : null;
}

export function setActivationPreference(kind: ActivatableResource, name: string, harness: HarnessId, enabled: boolean | null): void {
  if (!name || name.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(name)) throw new Error("Invalid resource name");
  schema();
  if (enabled === null) settingsDatabase().prepare("DELETE FROM resource_activation WHERE kind=? AND name=? AND harness=?").run(kind, name, harness);
  else settingsDatabase().prepare("INSERT INTO resource_activation(kind,name,harness,enabled) VALUES(?,?,?,?) ON CONFLICT(kind,name,harness) DO UPDATE SET enabled=excluded.enabled")
    .run(kind, name, harness, Number(enabled));
}

export function autoActivateSharedSkills(): boolean { return value("autoActivateSharedSkills", "true") === "true"; }

export function markReceivedResource(kind: "plugin" | "mcp", name: string, received: boolean): void {
  schema();
  if (received) settingsDatabase().prepare("INSERT OR IGNORE INTO received_resource_activation(kind,name) VALUES(?,?)").run(kind, name);
  else settingsDatabase().prepare("DELETE FROM received_resource_activation WHERE kind=? AND name=?").run(kind, name);
}

export function receivedResource(kind: "plugin" | "mcp", name: string): boolean {
  schema();
  if (settingsDatabase().prepare("SELECT 1 FROM received_resource_activation WHERE kind=? AND name=?").get(kind, name)) return true;
  // Older installations already had received Git resources before this table existed.
  try {
    const store = JSON.parse(readFileSync(path.join(resolveDataDirectory(), "git-resources", "sources.json"), "utf8")) as {
      sources?: Array<{ ownerNodeId?: string | null; installed?: Array<{ kind: string; name: string }> }>;
    };
    return store.sources?.some((source) => Boolean(source.ownerNodeId) && source.installed?.some((item) => item.kind === kind && (kind === "plugin" ? item.name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "_") : item.name) === name)) ?? false;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** A received marker is outside the shared folder, so it cannot be accidentally re-shared. */
export function receivedSkill(name: string, root = agentResourcePaths().sharedSkills): boolean {
  const key = createHash("sha256").update(`${path.resolve(root)}\0${name}`).digest("hex");
  return existsSync(path.join(resolveDataDirectory(), "skill-removals", `${key}.received`));
}

export function activationDecision(kind: ActivatableResource, name: string, harness: HarnessId, shared: boolean): ActivationDecision {
  const preference = activationPreference(kind, name, harness);
  const directive = kind === "skill" ? relaySkillDirective(settingsDatabase(), name, harness) : null;
  if (directive?.action === "block") return { enabled: false, reason: `Blocked by relay: ${directive.relays.join(", ")}`, preference, shared };
  if (preference === false) return { enabled: false, reason: "Disabled on this node", preference, shared };
  if (preference === true) return { enabled: true, reason: "Enabled on this node", preference, shared };
  if (directive?.action === "enable") return { enabled: true, reason: `Enabled by relay: ${directive.relays.join(", ")}`, preference, shared };
  const enabled = !shared || autoActivateSharedSkills();
  return { enabled, reason: shared ? enabled ? "Auto-activate shared skills" : "Shared resource awaits activation" : "Local resource", preference, shared };
}

/** Build a private skills root for one harness. Never mutate or delete original skills. */
export function skillNameFromFile(file: string, fallback: string): string {
  const content = readFileSync(file, "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!frontmatter) return fallback;
  const parsed: unknown = parseYaml(frontmatter[1]);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;
  const name = (parsed as { name?: unknown }).name;
  if (name === undefined) return fallback;
  if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(name)) throw new Error(`Invalid skill name in ${file}`);
  return name;
}

export function blockedSkillNames(harness: HarnessId): string[] {
  schema();
  const local = settingsDatabase().prepare("SELECT name FROM resource_activation WHERE kind='skill' AND harness=? AND enabled=0")
    .all(harness) as Array<{ name: string }>;
  const relay = relayPolicySubscriptions(settingsDatabase()).filter(({ optedIn }) => optedIn)
    .flatMap(({ statement }) => (statement?.body.rules ?? []).filter((rule) => rule.action === "block" && (rule.harness === "all" || rule.harness === harness)).map((rule) => rule.name));
  return [...new Set([...local.map((item) => item.name), ...relay])];
}

export function activeSkillRoot(harness: HarnessId, root = agentResourcePaths().sharedSkills): string {
  if (!existsSync(root)) return root;
  const empty = path.join(resolveDataDirectory(), "runtime", "active-skills", harness, "empty");
  if (statSync(root).isFile()) {
    const name = skillNameFromFile(root, path.basename(path.dirname(root)));
    const canonical = realpathSync(root);
    const received = path.basename(root) === "SKILL.md" && (receivedSkill(path.basename(path.dirname(root)), path.dirname(path.dirname(root)))
      || receivedSkill(path.basename(path.dirname(canonical)), path.dirname(path.dirname(canonical))));
    if (activationDecision("skill", name, harness, received).enabled) return root;
    mkdirSync(empty, { recursive: true });
    return empty;
  }
  const files: string[] = [];
  const directories: string[] = [];
  const visiting = new Set<string>();
  let excluded = false;
  let examined = 0;
  const canonicalRoot = realpathSync(root);
  const visit = (directory: string, relative: string): void => {
    const real = realpathSync(directory);
    if (visiting.has(real)) throw new Error(`Cyclic skill directory: ${directory}`);
    if (++examined > 4096) throw new Error(`Too many skill files in ${root}`);
    visiting.add(real);
    const manifest = path.join(directory, "SKILL.md");
    if (existsSync(manifest)) {
      const fallback = path.basename(directory);
      const name = skillNameFromFile(manifest, fallback);
      const first = relative.split(path.sep)[0] || fallback;
      const markerRoot = relative ? root : path.dirname(root);
      const canonicalMarkerRoot = relative ? canonicalRoot : path.dirname(canonicalRoot);
      if (!activationDecision("skill", name, harness, receivedSkill(first, markerRoot) || receivedSkill(first, canonicalMarkerRoot)).enabled) {
        excluded = true;
        visiting.delete(real);
        return;
      }
    }
    directories.push(relative);
    for (const entry of readdirSync(directory).sort()) {
      const child = path.join(directory, entry);
      const childRelative = path.join(relative, entry);
      if (statSync(child).isDirectory()) visit(child, childRelative);
      else files.push(childRelative);
    }
    visiting.delete(real);
  };
  visit(root, "");
  if (!excluded) return root;
  const digest = createHash("sha256").update(`${canonicalRoot}\0${harness}\0${files.join("\0")}`).digest("hex");
  const destination = path.join(resolveDataDirectory(), "runtime", "active-skills", harness, digest);
  if (!existsSync(destination)) {
    const temporary = `${destination}.${randomUUID()}.tmp`;
    mkdirSync(temporary, { recursive: true });
    try {
      for (const directory of directories) mkdirSync(path.join(temporary, directory), { recursive: true });
      for (const file of files) symlinkSync(path.join(root, file), path.join(temporary, file), "file");
      mkdirSync(path.dirname(destination), { recursive: true });
      try { renameSync(temporary, destination); }
      catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "") || !existsSync(destination)) throw error; }
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  return destination;
}

/** Only the selected harness receives approved servers; source config stays unchanged. */
export function assertNoBlockedNativeSkills(harness: HarnessId, cwd: string): void {
  for (const root of [path.join(cwd, ".agents/skills"), path.join(cwd, harness === "claude" ? ".claude/skills" : ".kiro/skills")]) {
    if (existsSync(root) && activeSkillRoot(harness, root) !== root) {
      throw new Error(`Cannot safely suppress blocked native ${harness} skills in ${root}. Remove the native copies or change their activation rules.`);
    }
  }
}

export function activeMcpConfig(harness: HarnessId, file = agentResourcePaths().mcpConfig): string {
  if (!existsSync(file)) return file;
  const content = JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, unknown> };
  const mcpServers = Object.fromEntries(Object.entries(content.mcpServers ?? {}).filter(([name]) =>
    activationDecision("mcp", name, harness, receivedResource("mcp", name)).enabled));
  const json = JSON.stringify({ ...content, mcpServers });
  const destination = path.join(resolveDataDirectory(), "runtime", "active-mcp", harness,
    `${createHash("sha256").update(json).digest("hex")}.json`);
  if (!existsSync(destination)) {
    mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, json, { mode: 0o600, flag: "wx" }); renameSync(temporary, destination); }
    finally { rmSync(temporary, { force: true }); }
  }
  return destination;
}
