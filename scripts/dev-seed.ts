// Builds a throwaway Joint Bob cluster under one directory: one or two nodes,
// each with its own SQLite database, sharing one HOME, dummy projects, and dummy
// Pi and Claude transcripts. Nothing here touches ~/.joint-bob, ~/.pi, or
// ~/.claude, so the whole thing is reset by deleting the root directory.
//
//   node --import tsx scripts/dev-seed.ts [--root <dir>] [--nodes 1|2] [--force] [--json]
//
// `scripts/dev-local.sh` runs this and then starts the servers against it.
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const asJson = process.argv.includes("--json");
const force = process.argv.includes("--force");
const root = path.resolve(flagValue("--root") ?? process.env.JOINT_BOB_DEV_ROOT ?? path.join(repositoryRoot, ".dev-env"));
const nodeCount = Number(flagValue("--nodes") ?? process.env.JOINT_BOB_DEV_NODES ?? 1);
const username = process.env.JOINT_BOB_DEV_USERNAME ?? "dev";
const password = process.env.JOINT_BOB_DEV_PASSWORD ?? "joint-bob-dev-password";

if (![1, 2].includes(nodeCount)) throw new Error("--nodes must be 1 or 2");

// The whole point of this environment is that it is disposable, so refuse to
// build one on top of a real node's state.
const protectedRoots = [os.homedir(), path.join(os.homedir(), ".joint-bob"), path.join(os.homedir(), ".claude"), path.join(os.homedir(), ".pi")];
if (protectedRoots.some((protectedRoot) => path.resolve(protectedRoot) === root)) throw new Error(`Refusing to seed a dev environment into ${root}`);

const home = path.join(root, "home");
const projectsRoot = path.join(root, "projects");
const piSessionRoot = path.join(home, ".pi", "sessions");
const claudeConfigRoot = path.join(home, ".claude");
const claudeProjectsRoot = path.join(claudeConfigRoot, "projects");

// Both nodes share HOME, the project folders, and the transcript roots. On a real
// cluster Syncthing keeps those in step between machines; on one machine sharing
// them directly is the closest equivalent, and it is what the mesh tests do.
interface NodeSpec { key: string; name: string; port: number; dataDir: string; url: string; cookieName: string }
const nodeSpecs: NodeSpec[] = [
  { key: "a", name: "Dev node A", port: Number(process.env.JOINT_BOB_DEV_PORT_A ?? 8791) },
  { key: "b", name: "Dev node B", port: Number(process.env.JOINT_BOB_DEV_PORT_B ?? 8792) },
].slice(0, nodeCount).map((spec) => ({
  ...spec,
  dataDir: path.join(root, "nodes", spec.key, "data"),
  url: `http://127.0.0.1:${spec.port}`,
  // Cookies ignore the port, so two nodes on 127.0.0.1 would overwrite each
  // other's session cookie without a per-node name.
  cookieName: `mb_session_dev_${spec.key}`,
}));

if (force) await rm(root, { recursive: true, force: true });
await Promise.all([home, projectsRoot, piSessionRoot, claudeProjectsRoot, ...nodeSpecs.map((spec) => spec.dataDir)].map((directory) => mkdir(directory, { recursive: true })));

const { claudeProjectDir } = await import("../src/session-paths.js");

interface Turn { role: "user" | "assistant"; text: string }
interface Conversation { harness: "pi" | "claude"; id: string; title: string; turns: Turn[] }
interface DemoProject { name: string; directory: string; conversations: Conversation[] }

function at(minutes: number): string {
  return new Date(Date.parse("2026-08-30T09:00:00.000Z") + minutes * 60_000).toISOString();
}

function piTranscript(conversation: Conversation, cwd: string): string {
  const records: unknown[] = [
    { type: "session", version: 3, id: conversation.id, timestamp: at(0), cwd },
    { type: "session_info", name: conversation.title, timestamp: at(0) },
  ];
  conversation.turns.forEach((turn, index) => {
    records.push({
      type: "message",
      id: `${conversation.id}-${index}`,
      parentId: index ? `${conversation.id}-${index - 1}` : null,
      timestamp: at(index + 1),
      message: { role: turn.role, content: [{ type: "text", text: turn.text }], timestamp: Date.parse(at(index + 1)) },
    });
  });
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function claudeTranscript(conversation: Conversation, cwd: string): string {
  const records: unknown[] = [{ type: "ai-title", aiTitle: conversation.title, cwd, timestamp: at(0) }];
  conversation.turns.forEach((turn, index) => {
    records.push({
      type: turn.role,
      uuid: `${conversation.id}-${index}`,
      cwd,
      timestamp: at(index + 1),
      message: {
        role: turn.role,
        ...(turn.role === "assistant" ? { model: "claude-opus-5", usage: { input_tokens: 18_400, output_tokens: 1_250 } } : {}),
        content: [{ type: "text", text: turn.text }],
      },
    });
  });
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

const demoProjects: DemoProject[] = [
  {
    name: "Internal Assistant",
    directory: "internal-assistant",
    conversations: [
      {
        harness: "pi", id: "thread-based-agent-builder", title: "Thread-Based Agent Builder",
        turns: [
          { role: "user", text: "We keep re-threading the same builder prompt by hand. Can we make the thread itself the unit of work, so a follow-up starts from the tail of the thread instead of a cold context every time?" },
          { role: "assistant", text: "Yes. The thread already stores every turn, so the builder can resume from the last assistant message and only the delta needs to be sent. The shape is written up in `./README.md`." },
        ],
      },
      {
        harness: "pi", id: "mobile-multi-agent-threads", title: "Mobile Multi-Agent Threads",
        turns: [
          { role: "user", text: "On mobile the thread list collapses the agent avatars, so two running agents look identical at a glance. Add a per-agent colour plus a running badge that survives the collapse." },
          { role: "assistant", text: "The list already carries the agent id per row, so colour and badge can both be derived without another request." },
        ],
      },
      {
        harness: "pi", id: "flow-runner-tool-evaluation", title: "Flow Runner Tool Evaluation",
        turns: [
          { role: "user", text: "Compare the three flow runners we shortlisted on cold-start latency, retry semantics, and whether they can resume a run that failed halfway through a fan-out step." },
          { role: "assistant", text: "Only one of the three resumes a partial fan-out; the other two replay the whole step." },
        ],
      },
      {
        harness: "pi", id: "short-one", title: "Short one",
        turns: [
          { role: "user", text: "Single short line." },
          { role: "assistant", text: "Understood." },
        ],
      },
      {
        harness: "pi", id: "long-title-conversation", title: "A very long conversation title that keeps going and going so the picker has something to wrap",
        turns: [
          { role: "user", text: "And a matching long first message, so the preview has to clamp to two lines and stop cleanly rather than being sliced mid-line by a row that is too short for it." },
          { role: "assistant", text: "Noted." },
        ],
      },
      {
        harness: "claude", id: "9f1c7a20-0e2b-4c51-9f2a-7d4b1c6e8a01", title: "Makor deployment information",
        turns: [
          { role: "user", text: "Deployment information for the Makor environment." },
          { role: "assistant", text: "It deploys from the release tag, not from the branch head." },
        ],
      },
      {
        harness: "claude", id: "1b8e6d33-52a4-4f77-8f0c-2a9e5b3d7c02", title: "Pending follow request review",
        turns: [
          { role: "user", text: "Pending follow request review." },
          { role: "assistant", text: "Three requests are still open." },
        ],
      },
    ],
  },
  {
    name: "Joint Bob",
    directory: "joint-bob",
    conversations: [
      {
        harness: "pi", id: "canvas-picker-readability", title: "Canvas picker readability",
        turns: [
          { role: "user", text: "The rows in the canvas conversation picker are squashed to their minimum height, so the preview line under each title is sliced in half and cannot be read at all." },
          { role: "assistant", text: "The list was a grid, and grid tracks shrink to min-content once the container hits its max height." },
        ],
      },
      {
        harness: "pi", id: "thread-notifications-naming", title: "Thread Notifications Naming and Pinning",
        turns: [
          { role: "user", text: "Naming is inconsistent between pinned threads and notification titles; pick one noun and use it everywhere, including the push payload." },
          { role: "assistant", text: "The push payload is the only place that still says 'conversation'." },
        ],
      },
      {
        harness: "claude", id: "3c5a9f18-7b6d-4e29-a1f4-8c0d2e5b9a03", title: "Bedrock open PR review",
        turns: [
          { role: "user", text: "Review the open PR against the Bedrock adapter and tell me whether the retry budget is per-request or per-session." },
          { role: "assistant", text: "Per-session: the counter lives on the adapter instance, not on the request." },
        ],
      },
    ],
  },
  {
    name: "Infra Scripts",
    directory: "infra-scripts",
    conversations: [
      {
        harness: "pi", id: "terraform-state-locking", title: "Terraform state locking",
        turns: [
          { role: "user", text: "Two apply runs collided last night and one of them left the lock table holding a stale entry, so this morning every plan refuses to start. Work out where the lock is released." },
          { role: "assistant", text: "The release only runs on a clean exit, so a killed apply leaves the row behind." },
        ],
      },
      {
        harness: "claude", id: "6d2f4b91-3a7c-4d18-b5e6-1f9a0c7d4e04", title: "EC2 smoke test flake",
        turns: [
          { role: "user", text: "The EC2 smoke test fails roughly one run in five, always on the health check." },
          { role: "assistant", text: "The check starts before the service finishes its first boot." },
        ],
      },
    ],
  },
];

// Dummy projects and transcripts are written once and shared by every node.
for (const demo of demoProjects) {
  const projectPath = path.join(projectsRoot, demo.directory);
  const claudeDirectory = claudeProjectDir(projectPath, claudeProjectsRoot);
  await mkdir(projectPath, { recursive: true });
  await mkdir(claudeDirectory, { recursive: true });
  await writeFile(path.join(projectPath, "README.md"), `# ${demo.name}\n\nDummy project for the Joint Bob dev environment.\n`);
  // A source file too, so the file viewer can be exercised on something that is not prose.
  await writeFile(path.join(projectPath, "config.ts"), `export const name = ${JSON.stringify(demo.name)};\nexport const enabled = true;\n`);
  for (const conversation of demo.conversations) {
    const [filePath, contents] = conversation.harness === "pi"
      ? [path.join(piSessionRoot, `${conversation.id}.jsonl`), piTranscript(conversation, projectPath)]
      : [path.join(claudeDirectory, `${conversation.id}.jsonl`), claudeTranscript(conversation, projectPath)];
    await writeFile(filePath, contents);
  }
}

function seedNodeDatabase(job: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/dev-seed-node.ts"], {
      cwd: repositoryRoot, env: process.env, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => status === 0 ? resolve(JSON.parse(stdout.trim())) : reject(new Error(stderr || `node seeder exited ${status}`)));
    child.stdin.end(JSON.stringify(job));
  });
}

interface SeededNode extends NodeSpec { nodeId: string; token: string; projects: Array<{ id: string; name: string; path: string }> }

const seeded: SeededNode[] = [];
for (const spec of nodeSpecs) {
  const result = await seedNodeDatabase({
    mode: "seed",
    dataDir: spec.dataDir,
    home,
    node: { name: spec.name, url: spec.url },
    admin: { username, password },
    paths: { piSessions: piSessionRoot, claudeConfig: claudeConfigRoot, claudeProjects: claudeProjectsRoot, projectsHome: path.join(home, "JointBob") },
    projects: demoProjects.map((demo) => ({ name: demo.name, path: path.join(projectsRoot, demo.directory) })),
  }) as { nodeId: string; token: string; projects: SeededNode["projects"] };
  seeded.push({ ...spec, ...result });
}

// Each node gets the other as a paired peer, and every project is aliased to its
// twin so a conversation can be handed between nodes.
for (const node of seeded) {
  const others = seeded.filter((other) => other.nodeId !== node.nodeId);
  if (!others.length) continue;
  await seedNodeDatabase({
    mode: "pair",
    dataDir: node.dataDir,
    home,
    peers: others.map((other) => ({ id: other.nodeId, name: other.name, url: other.url, token: other.token })),
    aliases: node.projects.map((project) => ({
      projectId: project.id,
      aliasIds: others.flatMap((other) => other.projects.filter((twin) => twin.path === project.path).map((twin) => twin.id)),
    })),
  });
}

const summary = {
  root,
  home,
  username,
  password,
  // The first node's database, kept as a top-level field so single-node callers
  // do not have to reach into `nodes`.
  dataDir: seeded[0].dataDir,
  projects: seeded[0].projects,
  nodes: seeded.map((node) => ({
    key: node.key, name: node.name, port: node.port, url: node.url, dataDir: node.dataDir,
    cookieName: node.cookieName, nodeId: node.nodeId, projects: node.projects,
  })),
};

if (asJson) {
  console.log(JSON.stringify(summary));
} else {
  console.log(`Dev environment ready at ${root}`);
  console.log(`  home     ${home}`);
  console.log(`  sign in  ${username} / ${password}`);
  for (const node of summary.nodes) console.log(`  node ${node.key}   ${node.url}  (${node.projects.length} projects)`);
  console.log(summary.nodes.length > 1 ? "\nStart both with: npm run dev:cluster" : "\nStart it with: npm run dev:local");
}
