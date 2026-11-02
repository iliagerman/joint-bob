// A stand-in for the decision model the assistant routes its messages with (TypeSafe's System One
// endpoint), so the assistant take runs on throwaway nodes with no real key and no network. It
// answers the "route" question the way the real model would for this take's few messages: a
// question about progress is recalled from history, a meeting or a launch is a new topic, and
// anything else carries on with the latest topic. Every other question is refused, so nothing
// else in the app is decided by it.
import { createServer, type Server } from "node:http";

export const decisionsPort = 8897;

interface Question { type: string; criteria: Record<string, string> }

function route(state: string, criteria: Record<string, string>): string {
  let message = "";
  try { message = String((JSON.parse(state) as { user_message?: unknown }).user_message ?? ""); } catch { message = state; }
  if (/how far along|how('s| is) .* going|on track|ready for/i.test(message)) return "recall_history";
  if (/\bbook\b|meeting|calendar|launch|release checklist/i.test(message)) return "new_topic";
  return "topic_0" in criteria ? "topic_0" : "new_topic";
}

export function startDecisions(): Promise<Server> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      try {
        const { state, questions } = JSON.parse(body) as { state: string; questions: Record<string, Question> };
        const asked = questions.route;
        if (!asked) { response.writeHead(503).end(); return; }
        const choice = route(state, asked.criteria);
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ answers: { route: { type: "choice", choice, confidence: 0.92 } } }));
      } catch { response.writeHead(400).end(); }
    });
  });
  return new Promise((resolve) => server.listen(decisionsPort, "127.0.0.1", () => resolve(server)));
}
