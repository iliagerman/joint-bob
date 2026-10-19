import path from "node:path";
import { agentResourcePaths } from "../agent-resources.js";
import { resourceInventory } from "../resource-inventory.js";
import { buildSkillBundle } from "../skill-sharing.js";
import { getClusterNode } from "../cluster.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { relayServerInstance } from "./index.js";
import { emptyRelayEnabledResources, publishedRelayPolicy, publishRelayPolicy, type RelayEnabledResources, type RelayResourceSettings } from "./resource-policy.js";
import { servingSettings } from "./store.js";

const HARNESSES = ["pi", "claude", "kiro"] as const;

/** What this machine has enabled per agent right now; a relay publishes it so followers can enforce or restrict to it. */
export async function relayEnabledSnapshot(): Promise<RelayEnabledResources> {
  const inventory = await resourceInventory({});
  const result = emptyRelayEnabledResources();
  const add = (kind: keyof RelayEnabledResources, item: { name: string; enabled?: boolean; activation?: Partial<Record<(typeof HARNESSES)[number], { enabled: boolean }>> }): void => {
    for (const harness of HARNESSES) {
      if (item.enabled !== false && item.activation?.[harness]?.enabled && !result[kind][harness].includes(item.name)) result[kind][harness].push(item.name);
    }
  };
  for (const item of inventory.skills) add("skills", item);
  for (const item of inventory.mcpServers) add("mcp", item);
  for (const item of inventory.plugins) add("plugins", item);
  for (const kind of ["skills", "mcp", "plugins"] as const) for (const harness of HARNESSES) result[kind][harness].sort().splice(512);
  return result;
}

/**
 * Digests of the skills this relay enforces, so followers can download them. Only skills that are
 * enabled here and live in this machine's managed skills are offered; the rest are enabled by name only.
 */
export async function enforcedSkillDigests(settings: RelayResourceSettings, enabled: RelayEnabledResources): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  if (!settings.skills.enforce) return digests;
  const names = [...new Set(HARNESSES.flatMap((harness) => enabled.skills[harness]))].sort();
  for (const name of names) {
    try { digests[name] = (await buildSkillBundle(path.join(agentResourcePaths().sharedSkills, name), name)).digest; }
    catch { /* not a managed skill on this machine, or too large to send */ }
  }
  return digests;
}

/** Keeps followers in step when this relay changes what it has enabled; only relays that enforce or restrict republish; edited enforced skills change their digest. */
export async function republishRelayResources(): Promise<void> {
  const db = await clusterV2Database();
  if (!servingSettings(db).enabled) return;
  const nodeId = (await getClusterNode()).id;
  const current = publishedRelayPolicy(db, nodeId).body;
  if (!Object.values(current.settings).some((toggle) => toggle.enforce || !toggle.allowOthers)) return;
  const enabled = await relayEnabledSnapshot();
  const skillDigests = await enforcedSkillDigests(current.settings, enabled);
  if (JSON.stringify(enabled) === JSON.stringify(current.enabled) && JSON.stringify(skillDigests) === JSON.stringify(current.skillDigests ?? {})) return;
  publishRelayPolicy(db, nodeId, current.rules, { settings: current.settings, enabled, skillDigests });
  relayServerInstance()?.broadcastSkillPolicy();
}
