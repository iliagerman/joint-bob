import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function functionBody(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `${header} not found`);
  const end = source.indexOf("\n}", start);
  assert.notEqual(end, -1, `${header} has no closing brace`);
  return source.slice(start, end);
}

test("sending a message on a ticket in review moves it back to in progress", async () => {
  const server = await readFile("src/server.ts", "utf8");
  const resume = functionBody(server, "async function resumeReviewedTask(connection: ChatConnection)");

  assert.match(server, /interface ChatConnection \{[\s\S]*taskId: string \| null;/);
  assert.match(server, /socket, project, taskId: task\?\.id \?\? null, cwd/);
  assert.match(resume, /task\.status !== "review"/);
  assert.match(resume, /updateTask\(connection\.project\.id, task\.id, \{ status: "in_progress" \}\)/);
  assert.match(resume, /broadcastToProject\(connection\.project\.id, \{ type: "tasksChanged" \}\)/);
  assert.match(functionBody(server, "async function handleClaudeCommand(connection: ChatConnection, payload: SocketPayload)"), /await resumeReviewedTask\(connection\)/);
  assert.match(functionBody(server, "async function handlePiCommand(connection: ChatConnection, shared: SharedPiSession, payload: SocketPayload)"), /await resumeReviewedTask\(connection\)/);
});
