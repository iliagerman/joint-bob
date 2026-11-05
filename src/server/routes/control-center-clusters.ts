// Control center: clusters. What other people in the person's clusters are running, limited to what they share.
import type { AuthSession } from "../../auth.js";
import { loadClusterView } from "../../control-center/clusters-data.js";
import "../../control-center/clusters-runtime.js";
import { app } from "../state.js";

/**
 * The running agents of other people in the person's clusters, grouped by machine. Everything comes from what this machine
 * already holds for projects shared with the person; nothing is asked of another machine, and nothing can be done to an agent
 * from here.
 */
app.get("/api/control-center/clusters", async (_request, response, next) => {
  try {
    response.json(await loadClusterView(response.locals.authSession as AuthSession));
  } catch (error) {
    next(error);
  }
});
