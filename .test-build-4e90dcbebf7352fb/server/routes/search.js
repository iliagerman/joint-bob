import { searchWorkspace } from "../../search.js";
import { app } from "../state.js";
app.get("/api/search", async (request, response, next) => {
  try {
    const query = typeof request.query.q === "string" ? request.query.q : "";
    response.json({ results: await searchWorkspace(query) });
  } catch (error) {
    next(error);
  }
});
