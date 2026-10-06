import { sendError } from "../http-auth.js";
import { app, server } from "../state.js";

// An unknown API route and an admin route seen by a non-admin answer alike. Installed when
// the server starts listening, after every route, including ones a test adds late.
let installed = false;
server.once("listening", () => {
  if (installed) return;
  installed = true;
  app.use("/api", (_request, response) => { sendError(response, 404, "Not found"); });
});
