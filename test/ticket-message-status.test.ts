import assert from "node:assert/strict";
import test from "node:test";
import { serverSource } from "./source.js";

function functionBody(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `${header} not found`);
  const end = source.indexOf("\n}", start);
  assert.notEqual(end, -1, `${header} has no closing brace`);
  return source.slice(start, end);
}

test("sending a message on a ticket in review moves it back to in progress", async () => {
  const server = await serverSource();
  const resume = functionBody(server, "async function resumeReviewedTask(connection: HarnessChatConnection)");
  const enqueue = functionBody(server, "async function enqueue(connection: HarnessChatConnection");

  assert.match(server, /export interface HarnessChatConnection \{[\s\S]*taskId: string \| null;/);
  assert.match(server, /socket, project, taskId: task\?\.id \?\? null, cwd/);
  assert.match(resume, /task\?\.status !== "review"/);
  assert.match(resume, /updateTask\(connection\.project\.id, task\.id, \{ status: "in_progress" \}\)/);
  assert.match(resume, /broadcastToProject\(connection\.project\.id, \{ type: "tasksChanged" \}\)/);
  const resumeCall = enqueue.indexOf("await resumeReviewedTask(connection)");
  const queueCall = enqueue.indexOf("enqueuePrompt(");
  assert.ok(resumeCall >= 0 && queueCall > resumeCall, "Review resumes once before the prompt is enqueued");
  assert.equal([...enqueue.matchAll(/await resumeReviewedTask\(connection\)/g)].length, 1);
  assert.doesNotMatch(server, /handleClaudeCommand|handlePiCommand/);
});
