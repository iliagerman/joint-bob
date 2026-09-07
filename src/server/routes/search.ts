import { searchWorkspace } from "../../search.js";
import { app } from "../state.js";

/* One bar over the whole workspace: every project, and every conversation inside them. */
app.get("/api/search", async (request, response, next) => {
  try {
    const query = typeof request.query.q === "string" ? request.query.q : "";
    response.json({ results: await searchWorkspace(query) });
  } catch (error) {
    next(error);
  }
});
