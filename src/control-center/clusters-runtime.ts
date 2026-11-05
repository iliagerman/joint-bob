import { askSystemOneChoices } from "../classifiers/typesafe.js";
import { bobDecisionModel } from "../server/bob.js";
import { projectsWithSharedNames } from "../server/projects.js";
import { registerBobContextProvider } from "./bob-hooks.js";
import { useClusters } from "./clusters-bob.js";
import { loadClusterView } from "./clusters-data.js";

/**
 * Bob's knowledge of other people's agents. It reads what this machine holds about projects shared with the person; it
 * never contacts another machine, and the text it adds says the agents are not Bob's to answer.
 */
registerBobContextProvider("clusters", async (turn) => {
  const view = await loadClusterView(turn.session);
  if (!view.machines.length) return null;
  const projects = await projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false });
  const model = await bobDecisionModel(projects, turn.settings);
  return useClusters(view, turn, {
    stateCharacters: model?.target.stateCharacters ?? 3_500,
    ask: async (state, questions) => model ? askSystemOneChoices(model.target, state, questions, model.apiKey) : null,
  });
});
