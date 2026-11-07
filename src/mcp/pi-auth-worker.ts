// Control-only worker. Runs as the same OS account as a Pi session, never opens a model.
import { createInterface } from "node:readline";
import { createPiNativeMcp } from "./pi-native.js";

let client: Awaited<ReturnType<typeof createPiNativeMcp>>;
let signingIn = false;
async function request(subtype: string, fields: Record<string, unknown>): Promise<unknown> {
  switch (subtype) {
    case "initialize": return {};
    case "mcp_status": return { mcpServers: await client.status() };
    case "mcp_authenticate": {
      const result = await client.start(String(fields.serverName)); signingIn = true;
      return { ...result, requiresUserAction: Boolean(result.authUrl) };
    }
    case "mcp_oauth_callback_url": return client.finish(String(fields.callbackUrl));
    case "mcp_reconnect": return signingIn ? client.finish() : {};
    case "mcp_clear_auth": await client.signOut(String(fields.serverName)); return {};
    default: throw new Error("Unsupported Pi MCP control request");
  }
}
const lines = createInterface({ input: process.stdin });
let pending = Promise.resolve();
lines.on("line", line => {
  pending = pending.then(async () => {
    const message = JSON.parse(line);
    if (message.type === "configure") { client = await createPiNativeMcp(message.servers, message.directory, message.cwd); return; }
    try {
      const result = await request(message.request.subtype, message.request);
      process.stdout.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: result } })}\n`);
    } catch (error) {
      const text = error instanceof Error && /^(Update the Pi harness|Invalid MCP sign-in callback|No Pi MCP sign-in|Native Pi MCP sign-in failed)/.test(error.message)
        ? error.message : "Native Pi MCP operation failed. Check the server configuration and sign-in.";
      process.stdout.write(`${JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: message.request_id, error: text } })}\n`);
    }
  });
  // Configuration and malformed input are fatal; no raw credential-bearing diagnostics.
  void pending.catch(() => { process.stderr.write("Pi MCP worker configuration failed\n"); process.exit(1); });
});
lines.on("close", () => { void pending.finally(async () => { await client?.close(); process.exit(0); }); });
