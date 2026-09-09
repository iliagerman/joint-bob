import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseSync } from "node:sqlite";
import { openPiRuntimeDatabase, publishPiRuntime, type PiRuntimeSession } from "./pi-runtime.js";

export function createPiRuntimeExtension(dataDirectory: string): (pi: ExtensionAPI) => void {
  return (pi) => {
    let database: DatabaseSync | undefined;
    let session: PiRuntimeSession | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      clearInterval(heartbeat);
      heartbeat = undefined;
      if (database && session) publishPiRuntime(database, session, false);
    };
    const start = (ctx: ExtensionContext) => {
      const transcriptPath = ctx.sessionManager.getSessionFile();
      if (!transcriptPath) return; // In-memory sessions have no app conversation.
      database ??= openPiRuntimeDatabase(dataDirectory);
      session = { sessionId: ctx.sessionManager.getSessionId(), transcriptPath, runId: session?.runId ?? randomUUID() };
      const publish = () => publishPiRuntime(database!, session!, true);
      publish();
      clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        try { publish(); }
        catch (error) {
          clearInterval(heartbeat);
          console.error("Joint Bob Pi runtime heartbeat failed", error);
        }
      }, 5_000);
      heartbeat.unref();
    };
    pi.on("session_start", (_event, ctx) => { if (!ctx.isIdle()) start(ctx); });
    pi.on("agent_start", (_event, ctx) => start(ctx));
    // agent_end can precede retries, compaction, and queued follow-ups.
    pi.on("agent_settled", (_event, ctx) => { if (ctx.isIdle()) stop(); });
    pi.on("session_shutdown", () => {
      stop();
      database?.close();
      database = undefined;
      session = undefined;
    });
  };
}
