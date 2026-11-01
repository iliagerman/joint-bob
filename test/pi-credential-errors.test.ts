import assert from "node:assert/strict";
import test from "node:test";
import { agentCapabilities } from "../src/agent-capabilities.js";
import { piSessionHooks } from "../src/pi-service.js";
import { addProject } from "../src/store.js";

test("Pi logs the original credential-refresh exception and still rejects the refresh", async (context) => {
  const project = await addProject("Credential failure", process.env.PI_WEB_DATA_DIR!);
  const failure = Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
  const logged = context.mock.method(console, "error", () => {});
  const capability = {
    id: "failing-credential-fixture", instructions: { path: "/fixture.md", content: "" },
    environment: () => { throw failure; },
  };
  agentCapabilities.push(capability);
  try {
    const hooks = piSessionHooks({ projectId: project.id, cwd: project.path });
    assert.throws(() => hooks.credentialsNow!("session-a", "conversation-a"), (error) => error === failure);
    const entry = logged.mock.calls.find(({ arguments: args }) => args.includes(failure));
    assert.ok(entry, "the server log must retain the original Error, including its SQLite code and stack");
    assert.match(String(entry.arguments[0]), /Pi.*credential/i);
  } finally { agentCapabilities.splice(agentCapabilities.indexOf(capability), 1); }
});
