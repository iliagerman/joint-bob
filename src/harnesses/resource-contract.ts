import type { CommandDiscoveryOptions, HarnessCommand } from "../commands.js";
import type { SkillRoots, SkillSummary } from "../skills.js";

export interface HarnessResources {
  skills(projectPath: string, roots: SkillRoots): Promise<SkillSummary[]>;
  commands(projectPath: string, options: CommandDiscoveryOptions): Promise<HarnessCommand[]>;
}
