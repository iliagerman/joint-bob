import { labelIconPrompt, parseGeneratedIcon } from "../conversation-labels.js";
import { getSettings } from "../settings.js";
import { listDiscoveredHarnesses } from "../harnesses/registry.js";
import { backgroundAgent } from "../background-agent.js";
import { runGitReview } from "./git-review-run.js";

export type LabelIconGenerator = (input: { label: string; harnessId: string; provider: string; modelId: string; prompt: string }) => Promise<string>;

/** An explicit harness wins; otherwise the background agent (Settings → Conversations). */
export function iconHarnessId(requested?: string): string {
  const runnable = listDiscoveredHarnesses().filter((adapter) => adapter.runtime && getSettings().conversationDefaults[adapter.id]);
  if (requested) {
    if (!runnable.some((adapter) => adapter.id === requested)) throw new Error(`Icon harness ${requested} cannot run agents on this node`);
    return requested;
  }
  if (!runnable.length) throw new Error("No agent is available on this node to generate an icon");
  return backgroundAgent().harnessId;
}

/**
 * Asks an agent for one emoji. It runs in a throwaway, tool-less session on the harness's
 * default model, so it never joins the project's conversations. Tests point
 * `JOINT_BOB_LABEL_ICON_GENERATOR` at a module whose default export plays the agent.
 */
export interface LabelIconChoice { harnessId?: string; provider?: string; modelId?: string }

export async function generateLabelIcon(label: string, choice: LabelIconChoice = {}): Promise<string> {
  const harnessId = iconHarnessId(choice.harnessId);
  // A model only makes sense with the agent it was picked for; otherwise the background agent's model applies.
  const background = choice.harnessId ? undefined : backgroundAgent();
  const model = background ? { provider: background.provider, modelId: background.modelId } : { provider: choice.provider ?? "", modelId: choice.modelId ?? "" };
  const prompt = labelIconPrompt(label);
  const override = process.env.JOINT_BOB_LABEL_ICON_GENERATOR;
  const answer = override
    ? await (await import(override) as { default: LabelIconGenerator }).default({ label, harnessId, ...model, prompt })
    : (await runGitReview({
      projectId: "label-icons", cwd: getSettings().projects.homePath, harnessId, ...model, thinkingLevel: background?.thinkingLevel ?? "",
      selection: { scope: "worktree" }, question: "", diff: "", instructions: prompt,
    })).answer;
  const icon = parseGeneratedIcon(answer);
  if (!icon) throw new Error("The agent did not answer with an icon; try again or enter one yourself");
  return icon;
}
