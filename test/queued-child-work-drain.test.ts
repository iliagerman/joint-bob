import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import test from "node:test";
import WebSocket from "ws";

import { configure, environment, gatedClaude, invocations, openChat, startServer, stopServer, temporaryRoot, waitFor, waitForInvocations } from "./queued-prompt-harness.js";

test("a queued prompt starts when tracked child work finishes", async () => {
  const root = await temporaryRoot("joint-bob-queue-child-work-");
  const previous = { ...process.env };
  Object.assign(process.env, environment(root));
  let server: Server | undefined;
  let dashboard: Server | undefined;
  let socket: WebSocket | undefined;
  try {
    const executable = await gatedClaude(root);
    const started = await startServer();
    server = started.server;
    const fixture = await configure(started.baseUrl, root, executable);
    let childStatus = "running";
    dashboard = createServer((_request, response) => response.end(JSON.stringify({ runs: [{ runId: "child-run", status: childStatus, tasks: [] }] })));
    await new Promise<void>((resolve) => dashboard!.listen(0, "127.0.0.1", resolve));
    const address = dashboard.address();
    assert.ok(address && typeof address !== "string");

    const opened = openChat(started.baseUrl, fixture.cookie, fixture.projectId, "claude:new");
    socket = opened.socket;
    await waitFor(opened.messages, () => opened.messages.some((message) => message.type === "ready"));
    const sessionId = String(opened.messages.find((message) => message.type === "ready")!.sessionId);
    const { recordConversationWork } = await import("../src/conversation-work.js");
    recordConversationWork({
      engine: "claude",
      sessionId,
      descriptor: { runId: "child-run", stateUrl: `http://127.0.0.1:${address.port}/api/state`, summary: { runId: "child-run", status: "running", tasks: [] } },
      summary: { runId: "child-run", status: "running", tasks: [] },
    });

    socket.send(JSON.stringify({ type: "prompt", message: "after children" }));
    await waitFor(opened.messages, () => opened.messages.some((message) => message.type === "queueUpdate" && message.pending === 1));
    assert.deepEqual(await invocations(), []);

    await writeFile(`${process.env.JOINT_BOB_FAKE_GATE}.after children`, "");
    childStatus = "succeeded";
    const [{ getClusterNode }, { buildRuntimeLeaseSnapshot }] = await Promise.all([
      import("../src/cluster.js"),
      import("../src/server/maintenance.js"),
    ]);
    await buildRuntimeLeaseSnapshot((await getClusterNode()).id);
    await waitForInvocations(["after children"], 2_000);
  } finally {
    socket?.terminate();
    if (dashboard) await new Promise<void>((resolve) => dashboard!.close(() => resolve()));
    await stopServer(server);
    process.env = previous;
    await rm(root, { recursive: true, force: true });
  }
});
