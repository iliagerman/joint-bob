// Scripted stand-in for the Claude CLI, used only by the promo video's disposable nodes.
//
// Joint Bob starts `claude -p --output-format stream-json ...`, writes the prompt to stdin and
// reads stream-json lines. This script answers the same way from a fixed scenario, so the real
// UI streams text and tool calls without a signed-in account or any real work.
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { scenarios, fallbackScenario } from "./scenarios.mjs";

const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.0 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })); process.exit(0); }
if (!args.includes("-p")) { console.error("promo stand-in: only -p runs are scripted"); process.exit(1); }

const flag = (name) => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
const sessionId = flag("--resume") ?? flag("--session-id") ?? randomUUID();
const model = flag("--model") ?? "claude-opus-5";
const speed = Number(process.env.JB_PROMO_SPEED ?? 1);
const cwd = process.cwd();

const prompt = await new Promise((resolve) => {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => resolve(input));
});

const scenario = scenarios.find((candidate) => candidate.match.test(prompt)) ?? fallbackScenario;
// A line per run in the scratch home, for working out why a take went wrong.
appendFileSync(path.join(process.env.HOME, "promo-agent.log"), `${JSON.stringify({ at: new Date().toISOString(), sessionId, resumed: args.includes("--resume"), scenario: String(scenario.match), prompt: prompt.slice(0, 400) })}\n`);

// Same directory rule as src/harnesses/claude/paths.ts.
const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME, ".claude");
const transcriptDir = path.join(configDir, "projects", cwd.replace(/^\//, "-").replace(/[\s_.\/]+/g, "-"));
const transcriptFile = path.join(transcriptDir, `${sessionId}.jsonl`);
mkdirSync(transcriptDir, { recursive: true });
const firstRun = !existsSync(transcriptFile) || readFileSync(transcriptFile, "utf8").trim() === "";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms / speed));
const out = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const persist = (type, message) => appendFileSync(transcriptFile, `${JSON.stringify({ type, uuid: randomUUID(), sessionId, cwd, timestamp: new Date().toISOString(), effort: "medium", message })}\n`);

let usedTokens = scenario.startTokens ?? 21_400;
const usage = () => ({ input_tokens: 12, cache_read_input_tokens: usedTokens, cache_creation_input_tokens: 2_400, cache_creation: { ephemeral_5m_input_tokens: 2_400, ephemeral_1h_input_tokens: 0 }, output_tokens: 240, service_tier: "standard" });

out({ type: "system", subtype: "init", session_id: sessionId, tools: ["Bash", "Edit", "Read", "Grep", "Glob", "Write"], model });
if (firstRun && scenario.title) appendFileSync(transcriptFile, `${JSON.stringify({ type: "ai-title", aiTitle: scenario.title, cwd, timestamp: new Date().toISOString() })}\n`);
persist("user", { role: "user", content: prompt });
await sleep(scenario.thinkMs ?? 500);

let lastText = "";
for (const step of scenario.steps) {
  const content = [];
  if (step.say) {
    // Word-sized deltas at a reading pace, like a live model stream.
    for (const piece of step.say.match(/\S+\s*/g) ?? []) {
      out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: piece } } });
      await sleep(step.wordMs ?? 34);
    }
    content.push({ type: "text", text: step.say });
    lastText = step.say;
  }
  const toolId = step.tool ? `toolu_${randomUUID().replaceAll("-", "").slice(0, 20)}` : undefined;
  if (step.tool) content.push({ type: "tool_use", id: toolId, name: step.tool.name, input: step.tool.input });
  usedTokens += step.tokens ?? 2_600;
  const message = { role: "assistant", model, usage: usage(), content };
  out({ type: "assistant", message });
  persist("assistant", message);
  if (step.tool) {
    await sleep(step.tool.ms ?? 700);
    // A step may do something real, such as drive the app's browser. What it returns is the tool's result.
    const ran = step.tool.run ? await step.tool.run().catch((error) => `Error: ${error.message}`) : undefined;
    const result = { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: ran ?? step.tool.result }] };
    out({ type: "user", message: result });
    persist("user", result);
    await sleep(180);
  }
  if (step.pauseMs) await sleep(step.pauseMs);
}

out({ type: "result", subtype: "success", is_error: false, result: lastText, session_id: sessionId });
