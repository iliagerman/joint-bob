import { createRequire } from "node:module";
import { format } from "node:util";
import { reportError } from "../error-reporting.js";
function forwardAsyncRouteErrors() {
  const require2 = createRequire(import.meta.url);
  const Layer = require2("express/lib/router/layer.js");
  if (Layer.prototype.asyncErrorsForwarded) return;
  Layer.prototype.asyncErrorsForwarded = true;
  Layer.prototype.handle_request = function handleRequest(request, response, next) {
    const handler = this.handle;
    if (handler.length > 3) {
      next();
      return;
    }
    try {
      const result = handler(request, response, next);
      if (result && typeof result.then === "function") result.then(void 0, (error) => next(error ?? new Error("Route handler rejected without a reason")));
    } catch (error) {
      next(error);
    }
  };
}
let forwarding = false;
function forward(values) {
  if (forwarding) return;
  forwarding = true;
  try {
    const [summary, ...detail] = format(...values).split("\n");
    void reportError("backend", { summary, detail: detail.join("\n") });
  } finally {
    forwarding = false;
  }
}
let installed = false;
function installBackendErrorCapture() {
  if (installed) return;
  installed = true;
  const writeError = console.error.bind(console);
  console.error = (...values) => {
    writeError(...values);
    forward(values);
  };
  process.on("unhandledRejection", (reason) => console.error("Unhandled promise rejection", reason));
  process.on("uncaughtException", (error) => {
    writeError("Uncaught exception; the node is exiting", error);
    const [summary, ...detail] = format("Uncaught exception; the node is exiting", error).split("\n");
    const exit = setTimeout(() => process.exit(1), 3e3);
    void reportError("backend", { summary, detail: detail.join("\n") }).finally(() => {
      clearTimeout(exit);
      process.exit(1);
    });
  });
}
export {
  forwardAsyncRouteErrors,
  installBackendErrorCapture
};
