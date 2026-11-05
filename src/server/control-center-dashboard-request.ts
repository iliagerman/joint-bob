import type { DatabaseSync } from "node:sqlite";
import type { AuthSession } from "../auth.js";
import type { SystemOneTarget } from "../classifiers/typesafe.js";
import { askSystemOneChoices } from "../classifiers/typesafe.js";
import { appendBobMessage, type BobMessage, type BobSettings } from "../control-center/bob-store.js";
import { DASHBOARD_INTENT_INSTRUCTIONS, decideDashboardIntent } from "../control-center/dashboard-intent.js";
import type { AskChoices, BobDecision } from "../control-center/decisions.js";
import { listWorkspaces } from "../store.js";
import type { HarnessId, ProjectRecord } from "../types.js";
import { startDashboardBuild, type BuildTarget } from "./control-center-dashboard-builds.js";
import { runGitReview } from "./git-review-run.js";
import { iconHarnessId } from "./label-icon.js";

export interface BobDashboardRequest {
  session: AuthSession;
  db: DatabaseSync;
  settings: BobSettings;
  message: string;
  recentChat: string[];
  /** The project the message is about: chosen by the person, or decided with enough confidence. */
  project: ProjectRecord | undefined;
  /** Every project the person can see, most recently used first. */
  projects: ProjectRecord[];
  /** The decision model's answer for this message when it was sure enough to use. */
  decision: BobDecision | null;
  /** The decision model Bob asks; null when none is set up. */
  model: { target: SystemOneTarget; apiKey: string } | null;
}

/** Bob's own agent answers the intent question when the decision model could not. It cannot use tools. */
async function askAgent(input: BobDashboardRequest, message: string): Promise<string> {
  const home = input.project ?? input.projects[0];
  const result = await runGitReview({
    projectId: home.id, cwd: home.path, harnessId: (input.settings.harnessId || iconHarnessId()) as HarnessId,
    provider: input.settings.provider, modelId: input.settings.modelId, thinkingLevel: input.settings.thinkingLevel,
    selection: { scope: "context", label: "Bob" }, question: message, diff: `Message:\n${message}`, instructions: DASHBOARD_INTENT_INSTRUCTIONS,
  });
  return result.answer;
}

const describe = (target: BuildTarget) => target.entity.kind === "project" ? `the dashboard for "${target.label}"` : `your own dashboard (workspace "${target.label}")`;

/** What the dashboard agent is asked: the person's words, and which of the dashboards in them this one is. */
function requestFor(target: BuildTarget, message: string): string {
  const scope = target.entity.kind === "project"
    ? `This is the project dashboard of "${target.label}".`
    : `This is the person's own dashboard, at the workspace level ("${target.label}"): it covers what the person needs across their projects, not one project.`;
  return `${message}\n\n${scope} If the request above asks for more than one dashboard, build only this one.`;
}

/** The workspace a "for me" dashboard goes to: the chosen project's, or the only one that has projects. */
async function personalTarget(input: BobDashboardRequest): Promise<BuildTarget | null> {
  const withProjects = (await listWorkspaces()).filter((workspace) => input.projects.some((project) => project.type === workspace.id));
  const workspace = input.project ? withProjects.find((candidate) => candidate.id === input.project!.type) : withProjects.length === 1 ? withProjects[0] : undefined;
  if (!workspace) return null;
  const host = input.project?.type === workspace.id ? input.project : input.projects.find((project) => project.type === workspace.id)!;
  return { entity: { kind: "workspace", id: workspace.id }, hostProjectId: host.id, label: workspace.label, projectId: null, projectName: null };
}

/**
 * Bob's reply when the message asks for a dashboard for a project, for the person, or both; null when it does not, and
 * the message goes on as usual. Bob starts the dashboard-creator agent for each and returns at once: when an agent is
 * done the dashboard is saved and Bob says so, with a button to the Dashboards tab. Which project or workspace is never
 * guessed: without one in the message or the chat's project box, Bob asks.
 */
export async function bobDashboardRequest(input: BobDashboardRequest): Promise<BobMessage | null> {
  // A question or an automation change is not a request to build anything: skip the extra decision.
  if (!input.projects.length || input.decision?.kind === "question" || input.decision?.kind === "automation") return null;
  const model = input.model;
  const ask: AskChoices | null = model ? (state, questions) => askSystemOneChoices(model.target, state, questions, model.apiKey) : null;
  const found = await decideDashboardIntent({
    message: input.message, recentChat: input.recentChat, threshold: input.settings.threshold, ask,
    stateCharacters: model?.target.stateCharacters ?? 0, agent: (message) => askAgent(input, message),
  });
  if (!found || (!found.intent.project && !found.intent.me)) return null;

  const via = found.by === "decision model" ? `Dashboards · decision model ${Math.round(found.confidence! * 100)}%` : "Dashboards · Bob's agent decided";
  const reply = (text: string, importance: "fyi" | "needs-you") => appendBobMessage(input.db, input.session.accountId, {
    role: "bob", text, via, importance, projectId: input.project?.id ?? null, projectName: input.project?.name ?? null,
  });
  const targets: BuildTarget[] = [];
  const questions: string[] = [];
  if (found.intent.project) {
    if (input.project) targets.push({ entity: { kind: "project", id: input.project.id }, hostProjectId: input.project.id, label: input.project.name, projectId: input.project.id, projectName: input.project.name });
    else questions.push("Which project is the dashboard for?");
  }
  if (found.intent.me) {
    const personal = await personalTarget(input);
    if (personal) targets.push(personal);
    else questions.push("Which workspace is your own dashboard for?");
  }
  if (questions.length) return reply(`${questions.join(" ")} Pick the project in the Project box under the chat (or name it) and send the request again.`, "needs-you");

  const started: string[] = [];
  const failed: string[] = [];
  for (const target of targets) {
    try {
      await startDashboardBuild(input.session, target, requestFor(target, input.message), input.message);
      started.push(describe(target));
    } catch (error) {
      failed.push(`${describe(target)}: ${(error as Error).message}`);
    }
  }
  const lines = [
    ...started.length ? [`Building ${started.join(" and ")}. The dashboard agent works in the background; I will tell you here when ${started.length > 1 ? "they are" : "it is"} done.`] : [],
    ...failed.length ? [`I could not start ${failed.join("; ")}.`] : [],
  ];
  return reply(lines.join(" "), started.length ? "fyi" : "needs-you");
}
