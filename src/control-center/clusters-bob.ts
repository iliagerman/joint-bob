import type { SystemOneChoice, SystemOneQuestion } from "../classifiers/typesafe.js";
import type { BobContribution, BobTurn } from "./bob-hooks.js";
import { clusterAgentsText, namesPeople, type ClusterView } from "./clusters.js";

/** What this needs from outside: the decision model. Null from `ask` means it is not set up or could not answer. */
export interface ClusterBobDeps {
  ask(state: string, questions: Record<string, SystemOneQuestion>): Promise<Record<string, SystemOneChoice> | null>;
  stateCharacters: number;
  now?: number;
}

const MESSAGE_CHARACTERS = 1_200;

const PEOPLE_QUESTION: SystemOneQuestion = {
  instructions: "Does the user's message ask about, or depend on, what other people (teammates or colleagues in their clusters, not the user) are working on right now?",
  criteria: {
    yes: "It asks what someone else, a teammate, the team or everyone is doing, working on, running or has finished, or it names one of the people listed.",
    no: "It is about the user's own work or projects, or something general, even when it mentions a project that others also work in.",
  },
};

/** The question's state: who the people are, then the message (cut to what is left of the budget), then recent chat when it still fits. */
function stateFor(turn: BobTurn, view: ClusterView, stateCharacters: number): string {
  const people = { people_and_machines: view.machines.map((machine) => machine.name), clusters: view.clusters.map((cluster) => cluster.name) };
  const room = Math.max(0, stateCharacters - JSON.stringify({ user_message: "", ...people }).length);
  const base = { user_message: turn.message.slice(0, Math.min(MESSAGE_CHARACTERS, room)), ...people };
  const withChat = JSON.stringify({ ...base, recent_chat: turn.recentChat.slice(-2).map((line) => line.slice(0, 300)) });
  return withChat.length <= stateCharacters ? withChat : JSON.stringify(base);
}

/**
 * Bob's reading of whether the message is about other people's work. One yes/no question goes to the decision model;
 * below Bob's saved confidence, or with no model, the explicit rule in `namesPeople` decides. Nothing is asked when no one
 * else is in the person's clusters.
 */
export async function messageIsAboutPeople(view: ClusterView, turn: BobTurn, deps: ClusterBobDeps): Promise<{ about: boolean; by: "decision model" | "rule" }> {
  const answers = await deps.ask(stateFor(turn, view, deps.stateCharacters), { people: PEOPLE_QUESTION });
  const answer = answers?.people;
  if (answer && answer.confidence >= turn.settings.threshold) return { about: answer.choice === "yes", by: "decision model" };
  return { about: namesPeople(turn.message, view), by: "rule" };
}

/**
 * What Bob's agent is shown about other people's agents: only when the message is about them, only what they share with
 * the person, only what runs. It is information; Bob never acts on, answers for or sends anything to those agents.
 */
export async function useClusters(view: ClusterView, turn: BobTurn, deps: ClusterBobDeps): Promise<BobContribution | null> {
  if (!view.machines.length) return null;
  const decided = await messageIsAboutPeople(view, turn, deps);
  if (!decided.about) return null;
  const running = view.machines.reduce((total, machine) => total + machine.agents.length, 0);
  return { text: clusterAgentsText(view, deps.now), via: `Cluster agents: ${running} running (${decided.by})` };
}
