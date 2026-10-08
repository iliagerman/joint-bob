import { randomUUID } from "node:crypto";
import { openPiRuntimeDatabase, publishPiRuntime } from "./pi-runtime.js";
function createPiRuntimeExtension(dataDirectory) {
  return (pi) => {
    let database;
    let session;
    let heartbeat;
    const stop = () => {
      clearInterval(heartbeat);
      heartbeat = void 0;
      if (database && session) publishPiRuntime(database, session, false);
    };
    const start = (ctx) => {
      const transcriptPath = ctx.sessionManager.getSessionFile();
      if (!transcriptPath) return;
      database ??= openPiRuntimeDatabase(dataDirectory);
      session = { sessionId: ctx.sessionManager.getSessionId(), transcriptPath, runId: session?.runId ?? randomUUID() };
      const publish = () => publishPiRuntime(database, session, true);
      publish();
      clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        try {
          publish();
        } catch (error) {
          clearInterval(heartbeat);
          console.error("Joint Bob Pi runtime heartbeat failed", error);
        }
      }, 5e3);
      heartbeat.unref();
    };
    pi.on("session_start", (_event, ctx) => {
      if (!ctx.isIdle()) start(ctx);
    });
    pi.on("agent_start", (_event, ctx) => start(ctx));
    pi.on("agent_settled", (_event, ctx) => {
      if (ctx.isIdle()) stop();
    });
    pi.on("session_shutdown", () => {
      stop();
      database?.close();
      database = void 0;
      session = void 0;
    });
  };
}
export {
  createPiRuntimeExtension
};
