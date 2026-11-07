// A stand-in for the decision model (TypeSafe's System One endpoint), so the assistant and control
// center takes run on throwaway nodes with no real key and no network.
//
// The assistant asks one "route" question: a question about progress is recalled from history, a
// meeting or a launch is a new topic, and anything else carries on with the latest topic.
//
// Bob (the control center) asks what a message is (kind, size), which project it is about, and a
// few yes/no checks (moving jobs, dashboards, memory, people). Those are answered the way the real
// model would for the take's few messages; every check the take does not use is answered with its
// "not this" choice, so nothing else is set off.
import { createServer, type Server } from "node:http";

export const decisionsPort = 8897;

interface Question { type: string; instructions?: string; criteria: Record<string, string> }

function route(state: string, criteria: Record<string, string>): string {
  let message = "";
  try { message = String((JSON.parse(state) as { user_message?: unknown }).user_message ?? ""); } catch { message = state; }
  if (/how far along|how('s| is) .* going|on track|ready for/i.test(message)) return "recall_history";
  if (/\bbook\b|meeting|calendar|launch|release checklist/i.test(message)) return "new_topic";
  return "topic_0" in criteria ? "topic_0" : "new_topic";
}

function messageOf(state: string): string {
  try { return String((JSON.parse(state) as { user_message?: unknown }).user_message ?? ""); } catch { return state; }
}

/** What Bob's message is: a schedule is an automation, a question is answered, anything else is work. */
function kindOf(message: string): string {
  if (/\bschedul|\bevery (day|week|monday|morning|evening)|\bwebhook|\breport\b/i.test(message)) return "automation";
  if (/\?\s*$/.test(message.trim()) || /^(what|how|is|are|which|who|when|where)\b/i.test(message.trim())) return "question";
  return "task";
}

/** The project a criterion names, when the message names the same project. */
function projectFor(message: string, criteria: Record<string, string>): string {
  const lower = message.toLowerCase();
  for (const [key, text] of Object.entries(criteria)) {
    const name = text.split(".")[0].trim().toLowerCase();
    if (key !== "none" && name && lower.includes(name)) return key;
  }
  return "none" in criteria ? "none" : Object.keys(criteria)[0];
}

// The choice that sets nothing off, for every check the take does not use.
const QUIET = ["other", "no", "nothing", "none", "any", "all"];

function bob(state: string, questions: Record<string, Question>): Record<string, { type: "choice"; choice: string; confidence: number }> {
  const message = messageOf(state);
  const kind = kindOf(message);
  const answers: Record<string, { type: "choice"; choice: string; confidence: number }> = {};
  for (const [id, question] of Object.entries(questions)) {
    const keys = Object.keys(question.criteria);
    let choice: string;
    if (id === "kind") choice = kind;
    else if (id === "size") choice = kind === "task" ? "long" : "short";
    else if (id === "project") choice = projectFor(message, question.criteria);
    else choice = QUIET.find((key) => keys.includes(key)) ?? keys[0];
    answers[id] = { type: "choice", choice, confidence: 0.96 };
  }
  return answers;
}

/** `assistant` answers only the route question and refuses the rest, as before; `control` also answers Bob. */
export function startDecisions(mode: "assistant" | "control" = "assistant"): Promise<Server> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      try {
        const { state, questions } = JSON.parse(body) as { state: string; questions: Record<string, Question> };
        if (!questions.route && mode !== "control") { response.writeHead(503).end(); return; }
        const answers = questions.route
          ? { route: { type: "choice", choice: route(state, questions.route.criteria), confidence: 0.92 } }
          : bob(state, questions);
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ answers }));
      } catch { response.writeHead(400).end(); }
    });
  });
  return new Promise((resolve) => server.listen(decisionsPort, "127.0.0.1", () => resolve(server)));
}
