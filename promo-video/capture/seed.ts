// Builds the promo video's throwaway environment: three nodes with invented projects and
// conversations. Same approach as scripts/dev-seed.ts, with content written for the camera.
// Nothing here reads or writes ~/.joint-bob, ~/.pi or ~/.claude.
//
//   node --import tsx promo-video/capture/seed.ts --root <dir>      (run from the repository root)
import { spawn } from "node:child_process";
import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeProjectDir } from "../../src/session-paths.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "../..");

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const requestedRoot = flagValue("--root");
if (!requestedRoot) throw new Error("--root <dir> is required");
await mkdir(requestedRoot, { recursive: true });
// The stand-in CLI derives the transcript folder from its real working directory.
const root = await realpath(requestedRoot);
if ([os.homedir(), path.join(os.homedir(), ".joint-bob"), path.join(os.homedir(), ".claude"), path.join(os.homedir(), ".pi")].some((candidate) => path.resolve(candidate) === root)) throw new Error(`Refusing to seed into ${root}`);

export const password = "promo-video-password-1";
const ports = { a: Number(process.env.JB_PROMO_PORT_A ?? 8891), b: Number(process.env.JB_PROMO_PORT_B ?? 8892), c: Number(process.env.JB_PROMO_PORT_C ?? 8893) };

interface NodeSpec { key: "a" | "b" | "c"; name: string; username: string; home: string; port: number; url: string; dataDir: string; cookieName: string }
const nodeSpecs: NodeSpec[] = ([
  // The laptop and the home server are the same person's machines; they share HOME the way
  // Syncthing would keep the two in step on real hardware.
  { key: "a", name: "MacBook Pro", username: "alex", home: path.join(root, "home") },
  { key: "b", name: "Home server", username: "alex", home: path.join(root, "home") },
  { key: "c", name: "Maya's MacBook", username: "maya", home: path.join(root, "home-maya") },
] as const).map((spec) => ({
  ...spec,
  port: ports[spec.key],
  url: `http://127.0.0.1:${ports[spec.key]}`,
  dataDir: path.join(root, "nodes", spec.key, "data"),
  cookieName: `jb_promo_${spec.key}`,
}));

interface Turn { role: "user" | "assistant"; text: string }
interface Conversation { harness: "pi" | "claude"; id: string; title: string; minutesAgo: number; turns: Turn[] }
interface DemoProject { name: string; directory: string; conversations: Conversation[] }

const demoProjects: DemoProject[] = [
  {
    name: "checkout-api", directory: "checkout-api",
    conversations: [
      { harness: "claude", id: "0a6c1c52-6c0e-4f0a-9d3e-2b7a51c4e101", title: "Refund webhook signature check", minutesAgo: 95, turns: [
        { role: "user", text: "The refund webhook accepts requests without a signature header. Reject them and add a test." },
        { role: "assistant", text: "Unsigned requests now get a 401 before the body is parsed. Added a test for a missing header and one for a wrong signature." },
      ] },
      { harness: "claude", id: "0a6c1c52-6c0e-4f0a-9d3e-2b7a51c4e111", title: "Tax rounding per line item", minutesAgo: 260, turns: [
        { role: "user", text: "Totals differ by one cent from the invoice when a cart has many small items. Round tax per line, not per cart." },
        { role: "assistant", text: "Tax is now rounded per line and summed. The invoice and the cart agree on all 40 fixture carts." },
      ] },
      { harness: "claude", id: "5e2b9d07-41f8-4a0c-8d51-9f3e6a7b2102", title: "Slow order history query", minutesAgo: 1500, turns: [
        { role: "user", text: "Order history takes four seconds for customers with many orders. Find out why." },
        { role: "assistant", text: "The query sorts before it filters by customer. A composite index on (customer_id, created_at) brings it to 40 ms." },
      ] },
    ],
  },
  {
    name: "web-storefront", directory: "web-storefront",
    conversations: [
      { harness: "claude", id: "b81f6a34-7c25-4e19-a6d2-0c5e8f1a3203", title: "Cart drawer focus trap", minutesAgo: 40, turns: [
        { role: "user", text: "Keyboard focus escapes the cart drawer and lands behind it. Trap focus while it is open." },
        { role: "assistant", text: "Focus now cycles inside the drawer and returns to the cart button on close." },
      ] },
      { harness: "claude", id: "0a6c1c52-6c0e-4f0a-9d3e-2b7a51c4e112", title: "Lazy-load product gallery images", minutesAgo: 320, turns: [
        { role: "user", text: "The product page loads all twelve gallery images up front. Load only what is visible." },
        { role: "assistant", text: "Images below the fold load on scroll. Largest Contentful Paint went from 3.1 s to 1.4 s on the test page." },
      ] },
    ],
  },
  {
    name: "billing-worker", directory: "billing-worker",
    conversations: [
      { harness: "claude", id: "0a6c1c52-6c0e-4f0a-9d3e-2b7a51c4e113", title: "Invoice PDF drops accented letters", minutesAgo: 180, turns: [
        { role: "user", text: "Customer names with accents print as boxes in invoice PDFs." },
        { role: "assistant", text: "The PDF font had no Latin Extended glyphs. Embedded a font that does and added a fixture name with accents." },
      ] },
      { harness: "claude", id: "c4d7e210-95ab-4c3f-b8e6-7a1d2f9c4304", title: "Retry queue backoff", minutesAgo: 2900, turns: [
        { role: "user", text: "Failed invoice jobs retry immediately and hammer the mail provider. Add backoff." },
        { role: "assistant", text: "Retries now wait 1, 4 and 16 minutes, then park the job for review." },
      ] },
    ],
  },
  {
    name: "infra", directory: "infra",
    conversations: [
      { harness: "claude", id: "d93a5b68-2e7f-4b41-9c0d-8e6f1a2b5405", title: "Staging database resize", minutesAgo: 700, turns: [
        { role: "user", text: "Plan a resize of the staging database with no more than a minute of downtime." },
        { role: "assistant", text: "A read replica promoted during a maintenance window does it in about 40 seconds. The plan is in docs/staging-resize.md." },
      ] },
    ],
  },
  {
    // A support phone line answered by a voice agent: flows, prompts and call recordings.
    name: "support-line", directory: "support-line",
    conversations: [
      { harness: "claude", id: "0a6c1c52-6c0e-4f0a-9d3e-2b7a51c4e121", title: "Greeting is too long", minutesAgo: 150, turns: [
        { role: "user", text: "Callers hang up before the greeting ends. Cut it to one sentence." },
        { role: "assistant", text: "The greeting is now nine words. Hang-ups in the first ten seconds should drop; the next call review will show it." },
      ] },
      { harness: "claude", id: "0a6c1c52-6c0e-4f0a-9d3e-2b7a51c4e122", title: "Spanish fallback voice", minutesAgo: 1900, turns: [
        { role: "user", text: "When a caller speaks Spanish we answer in English. Detect it and switch voice." },
        { role: "assistant", text: "Language is detected from the first utterance and the Spanish voice takes over. Added six recorded calls as fixtures." },
      ] },
    ],
  },
  {
    name: "mobile-app", directory: "mobile-app",
    conversations: [
      { harness: "claude", id: "0a6c1c52-6c0e-4f0a-9d3e-2b7a51c4e114", title: "Push permission prompt timing", minutesAgo: 430, turns: [
        { role: "user", text: "We ask for push permission on first launch and most people decline. Ask after the first order instead." },
        { role: "assistant", text: "The prompt now appears on the order confirmation screen, once." },
      ] },
    ],
  },
];

// The team film's setup ends on a conversation list, and the scene after it happens inside
// "Payment retry double-charge". With `--with retry` that conversation is already there.
if (flagValue("--with") === "retry") {
  demoProjects[0].conversations.unshift({ harness: "claude", id: "0a6c1c52-6c0e-4f0a-9d3e-2b7a51c4e131", title: "Payment retry double-charge", minutesAgo: 4, turns: [
    { role: "user", text: "Payment retries double-charge customers when the provider times out. Find the cause and fix it." },
    { role: "assistant", text: "Done. PR #212 reuses one idempotency key per order, so a retry after a timeout can no longer charge twice. 48 of 48 tests pass." },
  ] });
}

/** Token counts in the shape Claude writes them, complete enough for the app to price the request. */
function usage(cacheRead: number, output: number, cacheWrite: number, input: number): Record<string, unknown> {
  return { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, cache_creation: { ephemeral_5m_input_tokens: cacheWrite, ephemeral_1h_input_tokens: 0 }, service_tier: "standard" };
}

// A month of invented work, so the Costs dashboard has something true to say: which project
// and model the money went to, what changed against the weeks before, which skills were used
// and how often tools failed. Each entry is one long conversation.
interface Month { project: string; id: string; title: string; model: string; fromDay: number; toDay: number; turns: (day: number) => number; steps: number; output: number; skill?: string; failures: (day: number) => number }
const month: Month[] = [
  // This month: the payment migration is the big spend, and it is heaviest in the last week.
  { project: "checkout-api", id: "7a1e4c90-2b6d-4f3a-8c15-d0e9f2a6b701", title: "Payment provider migration", model: "claude-opus-5", fromDay: 16, toDay: 1, turns: (day) => (day <= 6 ? 7 : 3), steps: 6, output: 1.3, skill: "code-review", failures: () => 0.04 },
  { project: "checkout-api", id: "7a1e4c90-2b6d-4f3a-8c15-d0e9f2a6b702", title: "Fraud rule tuning", model: "claude-sonnet-5", fromDay: 44, toDay: 9, turns: () => 3, steps: 4, output: 0.9, failures: () => 0.05 },
  { project: "web-storefront", id: "7a1e4c90-2b6d-4f3a-8c15-d0e9f2a6b703", title: "Checkout redesign", model: "claude-sonnet-5", fromDay: 62, toDay: 8, turns: (day) => (day > 20 ? 5 : 2), steps: 5, output: 1.1, skill: "release-notes", failures: () => 0.05 },
  { project: "billing-worker", id: "7a1e4c90-2b6d-4f3a-8c15-d0e9f2a6b704", title: "Invoice engine rewrite", model: "claude-opus-5", fromDay: 50, toDay: 2, turns: () => 3, steps: 5, output: 1.0, skill: "db-migrations", failures: () => 0.24 },
  { project: "infra", id: "7a1e4c90-2b6d-4f3a-8c15-d0e9f2a6b705", title: "Terraform module cleanup", model: "claude-haiku-4-5", fromDay: 70, toDay: 2, turns: () => 5, steps: 4, output: 0.7, failures: (day) => (day > 12 ? 0.3 : 0.05) },
  { project: "mobile-app", id: "7a1e4c90-2b6d-4f3a-8c15-d0e9f2a6b706", title: "Offline cart sync", model: "claude-sonnet-5", fromDay: 11, toDay: 1, turns: () => 4, steps: 5, output: 1.0, failures: () => 0.05 },
];
const asks = ["Continue with the next step of the plan.", "The staging run failed, take a look.", "Review what changed and tighten the tests.", "Split this into smaller commits.", "Rebase on main and fix what breaks.", "Write up what is left."];
const tools: Array<[string, Record<string, unknown>, string]> = [
  ["Grep", { pattern: "TODO|FIXME", path: "src" }, "src/index.ts:42:  // TODO remove after the migration"],
  ["Read", { file_path: "src/index.ts" }, "export function start() {\n  return createServer(routes);\n}"],
  ["Edit", { file_path: "src/index.ts", old_string: "createServer(routes)", new_string: "createServer(routes, options)" }, "The file src/index.ts has been updated."],
  ["Bash", { command: "npm test", description: "Run the tests" }, "Tests: 112 passed, 112 total"],
];

function monthTranscript(entry: Month, cwd: string): string {
  let seed = [...entry.id].reduce((total, character) => (total * 31 + character.charCodeAt(0)) % 2147483647, 7);
  const random = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const records: unknown[] = [{ type: "ai-title", aiTitle: entry.title, cwd, timestamp: new Date(Date.now() - entry.fromDay * 86_400_000).toISOString() }];
  let count = 0;
  const record = (type: string, time: number, message: unknown): void => { records.push({ type, uuid: `${entry.id}-${count++}`, sessionId: entry.id, cwd, timestamp: new Date(time).toISOString(), effort: "medium", message }); };
  for (let day = entry.fromDay; day >= entry.toDay; day--) {
    // Work happens on weekdays, in working hours.
    const morning = new Date(Date.now() - day * 86_400_000);
    morning.setUTCHours(13, 0, 0, 0);
    if ([0, 6].includes(morning.getUTCDay())) continue;
    const turns = Math.max(1, Math.round(entry.turns(day) * (0.7 + random() * 0.6)));
    for (let turn = 0; turn < turns; turn++) {
      let time = morning.getTime() + ((turn + random()) / turns) * 8 * 3_600_000;
      record("user", time, { role: "user", content: asks[Math.floor(random() * asks.length)] });
      let context = 28_000 + Math.floor(random() * 60_000);
      const steps = Math.max(2, Math.round(entry.steps * (0.6 + random() * 0.8)));
      for (let step = 0; step < steps; step++) {
        time += 4_000 + random() * 26_000;
        const useSkill = step === 0 && entry.skill && random() < 0.45;
        const [name, input, result] = useSkill ? ["Skill", { skill: entry.skill }, `Loaded the ${entry.skill} skill.`] as const : tools[Math.floor(random() * tools.length)];
        const id = `toolu_${entry.id.slice(-4)}${count}`;
        context += 2_000 + Math.floor(random() * 9_000);
        record("assistant", time, { role: "assistant", model: entry.model, usage: usage(context, Math.round((180 + random() * 900) * entry.output), 1_500 + Math.floor(random() * 6_500), 20 + Math.floor(random() * 300)), content: [{ type: "text", text: "Working on it." }, { type: "tool_use", id, name, input }] });
        time += 600 + random() * 9_000;
        const failed = !useSkill && random() < entry.failures(day);
        record("user", time, { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: failed ? "Command failed with exit code 1" : result, ...(failed ? { is_error: true } : {}) }] });
      }
      time += 3_000 + random() * 12_000;
      record("assistant", time, { role: "assistant", model: entry.model, usage: usage(context + 4_000, Math.round((400 + random() * 1_400) * entry.output), 1_200, 40), content: [{ type: "text", text: "Done. The change is in place and the tests pass." }] });
    }
  }
  return `${records.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

function at(minutesAgo: number, offsetMinutes = 0): string {
  return new Date(Date.now() - (minutesAgo - offsetMinutes) * 60_000).toISOString();
}

function piTranscript(conversation: Conversation, cwd: string): string {
  const records: unknown[] = [
    { type: "session", version: 3, id: conversation.id, timestamp: at(conversation.minutesAgo), cwd },
    { type: "session_info", name: conversation.title, timestamp: at(conversation.minutesAgo) },
  ];
  conversation.turns.forEach((turn, index) => {
    records.push({
      type: "message", id: `${conversation.id}-${index}`, parentId: index ? `${conversation.id}-${index - 1}` : null,
      timestamp: at(conversation.minutesAgo, index + 1),
      message: { role: turn.role, content: [{ type: "text", text: turn.text }], timestamp: Date.parse(at(conversation.minutesAgo, index + 1)) },
    });
  });
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function claudeTranscript(conversation: Conversation, cwd: string): string {
  const records: unknown[] = [{ type: "ai-title", aiTitle: conversation.title, cwd, timestamp: at(conversation.minutesAgo) }];
  conversation.turns.forEach((turn, index) => {
    records.push({
      type: turn.role, uuid: `${conversation.id}-${index}`, cwd, timestamp: at(conversation.minutesAgo, index + 1), effort: "medium",
      message: {
        role: turn.role,
        ...(turn.role === "assistant" ? { model: "claude-opus-5", usage: usage(18_400, 1_250, 2_100, 60) } : {}),
        content: [{ type: "text", text: turn.text }],
      },
    });
  });
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

const projectsRoot = path.join(root, "projects");
const standInRoot = path.join(root, "bin");
await mkdir(standInRoot, { recursive: true });
// `claude` answers from promo-video/capture/scenarios.mjs; Kiro only passes the sign-in checks.
await writeFile(path.join(standInRoot, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(here, "fake-claude.mjs")}" "$@"\n`);
await writeFile(path.join(standInRoot, "kiro-cli"), `#!/bin/sh
case "$1" in
  --version) echo "1.20.0" ;;
  whoami) echo "Logged in (promo environment)" ;;
  chat) echo '{"models":[{"model_id":"default","model_name":"Kiro default"}]}' ;;
  *) echo "promo stand-in: cannot run conversations" >&2; exit 1 ;;
esac
`);
for (const name of ["claude", "kiro-cli"]) await chmod(path.join(standInRoot, name), 0o755);

for (const home of new Set(nodeSpecs.map((spec) => spec.home))) {
  await mkdir(path.join(home, ".pi", "sessions"), { recursive: true });
  await mkdir(path.join(home, ".claude", "projects"), { recursive: true });
  await mkdir(path.join(home, ".kiro"), { recursive: true });
  await writeFile(path.join(home, ".pi", "models.json"), `${JSON.stringify({
    providers: { "promo-environment": { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "promo-environment", models: [{ id: "gpt-6-sol" }, { id: "gpt-6-astra" }] } },
  }, null, 2)}\n`);
}

const sharedHome = nodeSpecs[0].home;
for (const demo of demoProjects) {
  const projectPath = path.join(projectsRoot, demo.directory);
  const claudeDirectory = claudeProjectDir(projectPath, path.join(sharedHome, ".claude", "projects"));
  await mkdir(projectPath, { recursive: true });
  await mkdir(claudeDirectory, { recursive: true });
  await writeFile(path.join(projectPath, "README.md"), `# ${demo.name}\n\nInvented project for the Joint Bob promo video.\n`);
  for (const entry of month.filter((candidate) => candidate.project === demo.name)) await writeFile(path.join(claudeDirectory, `${entry.id}.jsonl`), monthTranscript(entry, projectPath));
  for (const conversation of demo.conversations) {
    const [filePath, contents] = conversation.harness === "pi"
      ? [path.join(sharedHome, ".pi", "sessions", `${conversation.id}.jsonl`), piTranscript(conversation, projectPath)]
      : [path.join(claudeDirectory, `${conversation.id}.jsonl`), claudeTranscript(conversation, projectPath)];
    await writeFile(filePath, contents);
  }
}

function seedNodeDatabase(job: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/dev-seed-node.ts"], { cwd: repositoryRoot, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => status === 0 ? resolve(JSON.parse(stdout.trim())) : reject(new Error(stderr || `node seeder exited ${status}`)));
    child.stdin.end(JSON.stringify(job));
  });
}

type SeededProject = { id: string; name: string; path: string };
const seeded: Array<NodeSpec & { nodeId: string; projects: SeededProject[] }> = [];
for (const spec of nodeSpecs) {
  await mkdir(spec.dataDir, { recursive: true });
  const result = await seedNodeDatabase({
    dataDir: spec.dataDir,
    home: spec.home,
    node: { name: spec.name, url: spec.url },
    admin: { username: spec.username, password, email: `${spec.username}@example.test` },
    paths: { piSessions: path.join(spec.home, ".pi", "sessions"), claudeConfig: path.join(spec.home, ".claude"), claudeProjects: path.join(spec.home, ".claude", "projects"), standIns: standInRoot, projectsHome: path.join(spec.home, "JointBob") },
    // The laptop owns the projects, the home server mirrors them as its twin, and the teammate
    // starts with none: hers arrive through cluster sharing.
    projects: spec.key === "a" ? demoProjects.map((demo) => ({ name: demo.name, path: path.join(projectsRoot, demo.directory) })) : [],
    ...(spec.key === "b" ? { mirrorProjects: seeded[0].projects } : {}),
  }) as { nodeId: string; projects: SeededProject[] };
  seeded.push({ ...spec, ...result });
}

const summary = { root, password, nodes: seeded.map(({ key, name, username, home, port, url, dataDir, cookieName, nodeId, projects }) => ({ key, name, username, home, port, url, dataDir, cookieName, nodeId, projects })) };
await writeFile(path.join(root, "environment.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary));
