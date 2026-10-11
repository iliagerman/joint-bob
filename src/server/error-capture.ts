import { createRequire } from "node:module";
import { format } from "node:util";
import type { NextFunction, Request, Response } from "express";
import { reportError } from "../error-reporting.js";

type RouteHandler = (request: Request, response: Response, next: NextFunction) => unknown;
interface ExpressLayer { handle: RouteHandler; handle_request(request: Request, response: Response, next: NextFunction): void }

/**
 * Express 4 drops a rejected async handler: the request hangs and the rejection
 * escapes as unhandled. Route every rejection to `next` so the error handler logs it.
 */
export function forwardAsyncRouteErrors(): void {
  const require = createRequire(import.meta.url);
  const Layer = require("express/lib/router/layer.js") as { prototype: ExpressLayer & { asyncErrorsForwarded?: boolean } };
  if (Layer.prototype.asyncErrorsForwarded) return;
  Layer.prototype.asyncErrorsForwarded = true;
  Layer.prototype.handle_request = function handleRequest(this: ExpressLayer, request, response, next) {
    const handler = this.handle;
    if (handler.length > 3) { next(); return; }
    try {
      const result = handler(request, response, next) as Promise<unknown> | undefined;
      if (result && typeof result.then === "function") result.then(undefined, (error: unknown) => next(error ?? new Error("Route handler rejected without a reason")));
    } catch (error) {
      next(error);
    }
  };
}

let forwarding = false;

function forward(values: unknown[]): void {
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

/** Mirrors console.error to the backend ntfy channel and keeps every unhandled failure in the log with its stack. */
export function installBackendErrorCapture(): void {
  if (installed) return;
  installed = true;
  const writeError = console.error.bind(console);
  console.error = (...values: unknown[]) => {
    writeError(...values);
    forward(values);
  };
  process.on("unhandledRejection", (reason) => console.error("Unhandled promise rejection", reason));
  process.on("uncaughtException", (error) => {
    writeError("Uncaught exception; the node is exiting", error);
    const [summary, ...detail] = format("Uncaught exception; the node is exiting", error).split("\n");
    const exit = setTimeout(() => process.exit(1), 3_000);
    void reportError("backend", { summary, detail: detail.join("\n") }).finally(() => { clearTimeout(exit); process.exit(1); });
  });
}
