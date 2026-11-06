import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { AutomationRow } from "../src/control-center/automations.js";
import type { BobMessage } from "../src/control-center/bob-store.js";
import type { CronTask } from "../src/cron.js";
import type { Webhook } from "../src/webhooks.js";
import { api, seedDevEnvironment, signIn, stopDevNode, waitForDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";
import { serverArgs } from "./server-entry.js";

const BASE = "/control-center/automations";

interface Listed { rows: AutomationRow[]; projects: Array<{ id: string; name: string }>; errors: string[] }
interface Timeline { messages: BobMessage[] }

/** A real node with the automation stand-ins preloaded: what Bob's agent answers is read from files the test writes. */
async function startNode(environment: DevEnvironment, node: SeededNode, directory: string): Promise<ChildProcess> {
  const env: NodeJS.ProcessEnv = {
    ...process.env, PORT: String(node.port), NODE_ENV: "test", HOME: environment.home, JOINT_BOB_DATA_DIR: node.dataDir, JOINT_BOB_SESSION_COOKIE: node.cookieName,
    JOINT_BOB_INSECURE_COOKIE: "1", JOINT_BOB_RELEASE: "development", JOINT_BOB_TEST_ENGINE_LOG: path.join(directory, "engine.log"), JOINT_BOB_TEST_AUTOMATION_DIR: directory,
  };
  delete env.TYPESAFE_AI_API_KEY;
  const child = spawn(process.execPath, serverArgs(env, ["./test/stub-harness-bootstrap.ts", "./test/stub-automation-bootstrap.ts"]), { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  return waitForDevNode(child, node.key, node.url);
}

async function until<T>(check: () => Promise<T | undefined | false>, what: string, seconds = 30): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const found = await check();
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

function nodeDatabase(node: SeededNode): DatabaseSync {
  const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

test("the automations list, toggle, edit and delete run through the existing scheduled task and webhook systems", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "control-automations-"));
  let child: ChildProcess | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const project = node.projects[0];
    const directory = path.join(root, "stubs");
    await mkdir(directory, { recursive: true });
    child = await startNode(environment, node, directory);
    const auth = await signIn(environment, node);
    const list = async () => (await api<Listed>(node, auth, "GET", BASE)).body;

    const empty = await list();
    assert.deepEqual(empty.rows, []);
    assert.ok(empty.projects.some((candidate) => candidate.id === project.id), "the projects are listed for the filter and the forms");

    // A scheduled task made here is an ordinary scheduled task: the project's own list has it, on this machine.
    const task = await api<{ task: CronTask }>(node, auth, "POST", `${BASE}/schedule`, { projectId: project.id, name: "Nightly release check", prompt: "Run the release gate, report only", schedule: { frequency: "daily", time: "02:00", timezone: "UTC" } });
    assert.equal(task.status, 201, JSON.stringify(task.body));
    assert.equal(task.body.task.ownerNodeId, node.nodeId);
    const existing = await api<{ tasks: CronTask[] }>(node, auth, "GET", `/projects/${project.id}/cron`);
    assert.deepEqual(existing.body.tasks.map((candidate) => [candidate.name, candidate.enabled, candidate.schedule.hour, candidate.schedule.minute, candidate.schedule.timezone]), [["Nightly release check", true, 2, 0, "UTC"]]);

    const hook = await api<{ webhook: Webhook; secret: string; bases: unknown[] }>(node, auth, "POST", `${BASE}/webhook`, { projectId: project.id, name: "GitHub issues", context: "Triage the issue, read only" });
    assert.equal(hook.status, 201, JSON.stringify(hook.body));
    assert.ok(hook.body.secret.length >= 20, "the secret address is returned once");
    assert.equal((await api<{ webhooks: Webhook[] }>(node, auth, "GET", "/webhooks")).body.webhooks.some((candidate) => candidate.name === "GitHub issues"), true, "the Webhooks settings see it too");

    const report = await api<{ schedule: { id: string; hour: number; minute: number; name: string; enabled: boolean } }>(node, auth, "POST", `${BASE}/bob`, { report: "evening", timezone: "UTC" });
    assert.equal(report.status, 201, JSON.stringify(report.body));
    assert.deepEqual([report.body.schedule.name, report.body.schedule.hour, report.body.schedule.minute], ["Evening report", 19, 0], "an evening report defaults to 19:00");

    // One list: Bob's reports first, then scheduled tasks, then webhooks, each with what the table shows.
    const listed = await list();
    assert.deepEqual(listed.rows.map((row) => [row.kind, row.name, row.enabled, row.projectName, row.when]), [
      ["bob", "Evening report", true, "All projects", "Daily 19:00 · Bob's chat"],
      ["schedule", "Nightly release check", true, project.name, "Daily 02:00"],
      ["webhook", "GitHub issues", true, project.name, "Starts a conversation · anyone with the address"],
    ]);
    assert.ok(listed.rows.every((row) => row.editable && row.last.state === "never"));
    const [bob, schedule, webhook] = listed.rows;

    // Pausing goes through the same update the old screens send, so they all agree.
    for (const row of listed.rows) assert.equal((await api(node, auth, "PUT", `${BASE}/${row.kind}/${row.id}/enabled`, { enabled: false })).status, 200);
    assert.deepEqual((await list()).rows.map((row) => [row.enabled, row.last.state]), [[false, "paused"], [false, "paused"], [false, "paused"]]);
    assert.equal((await api<{ tasks: CronTask[] }>(node, auth, "GET", `/projects/${project.id}/cron`)).body.tasks[0].enabled, false);
    assert.equal((await api<{ webhooks: Webhook[] }>(node, auth, "GET", "/webhooks")).body.webhooks.find((candidate) => candidate.id === webhook.id)!.enabled, false);
    assert.equal((await api(node, auth, "PUT", `${BASE}/schedule/${schedule.id}/enabled`, { enabled: true })).status, 200);

    // The compact editors keep everything they do not show.
    const edited = await api(node, auth, "PUT", `${BASE}/schedule/${schedule.id}`, { name: "Weekly release check", prompt: "Run the gate again", schedule: { frequency: "weekly", time: "08:30", weekday: 1, timezone: "UTC" } });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const [changed] = (await api<{ tasks: CronTask[] }>(node, auth, "GET", `/projects/${project.id}/cron`)).body.tasks;
    assert.deepEqual([changed.name, changed.prompt, changed.enabled, changed.schedule.frequency, changed.schedule.hour, changed.schedule.minute, changed.engine], ["Weekly release check", "Run the gate again", true, "weekly", 8, 30, task.body.task.engine]);
    assert.equal((await api(node, auth, "PUT", `${BASE}/webhook/${webhook.id}`, { name: "GitHub PRs", context: "Review the pull request", enabled: true })).status, 200);
    const [renamed] = (await api<{ webhooks: Webhook[] }>(node, auth, "GET", "/webhooks")).body.webhooks;
    assert.deepEqual([renamed.name, renamed.context, renamed.enabled, renamed.target.kind], ["GitHub PRs", "Review the pull request", true, "project"]);
    const moved = await api<{ schedule: { hour: number; minute: number; projectIds: string[] } }>(node, auth, "PUT", `${BASE}/bob/${bob.id}`, { time: "20:15", projectIds: [project.id], enabled: true });
    assert.deepEqual([moved.body.schedule.hour, moved.body.schedule.minute, moved.body.schedule.projectIds], [20, 15, [project.id]]);
    const afterEdits = (await list()).rows;
    assert.deepEqual(afterEdits.map((row) => [row.name, row.when]), [["Evening report", "Daily 20:15 · Bob's chat"], ["Weekly release check", "Mon 08:30"], ["GitHub PRs", "Starts a conversation · anyone with the address"]]);
    assert.deepEqual(afterEdits[0].projectIds, [project.id], "a report for chosen projects is tied to them");

    // Everything is checked at the boundary.
    for (const [method, url, body, status] of [
      ["PUT", `${BASE}/gadget/${schedule.id}/enabled`, { enabled: true }, 400],
      ["PUT", `${BASE}/schedule/${schedule.id}/enabled`, { enabled: "yes" }, 400],
      ["PUT", `${BASE}/schedule/${schedule.id}/enabled`, { enabled: true, extra: 1 }, 400],
      ["PUT", `${BASE}/schedule/not-there/enabled`, { enabled: true }, 404],
      ["DELETE", `${BASE}/webhook/not-there`, undefined, 404],
      ["POST", `${BASE}/schedule`, { projectId: project.id, name: "x", prompt: "y", schedule: { frequency: "daily", time: "25:00", timezone: "UTC" } }, 400],
      ["POST", `${BASE}/schedule`, { projectId: project.id, name: "x", prompt: "y", schedule: { frequency: "daily", time: "09:00", timezone: "Mars/Base" } }, 400],
      ["POST", `${BASE}/schedule`, { projectId: "no-such-project", name: "x", prompt: "y", schedule: { frequency: "daily", time: "09:00", timezone: "UTC" } }, 404],
      ["POST", `${BASE}/schedule`, { projectId: project.id, name: "x", prompt: "y", schedule: { frequency: "daily", time: "09:00", timezone: "UTC" }, ownerNodeId: "elsewhere" }, 400],
      ["POST", `${BASE}/webhook`, { projectId: project.id, name: "" }, 400],
      ["POST", `${BASE}/bob`, { report: "weekly", timezone: "UTC" }, 400],
      ["POST", `${BASE}/bob`, { report: "morning", timezone: "UTC", projectIds: ["no-such-project"] }, 404],
      ["PUT", `${BASE}/bob/not-there`, { enabled: false }, 404],
    ] as const) assert.equal((await api(node, auth, method, url, body)).status, status, `${method} ${url} ${JSON.stringify(body)}`);

    // Deleting removes it from the systems that own it.
    for (const row of afterEdits) assert.equal((await api(node, auth, "DELETE", `${BASE}/${row.kind}/${row.id}`)).status, 200);
    assert.deepEqual((await list()).rows, []);
    assert.deepEqual((await api<{ tasks: CronTask[] }>(node, auth, "GET", `/projects/${project.id}/cron`)).body.tasks, []);
    assert.deepEqual((await api<{ webhooks: Webhook[] }>(node, auth, "GET", "/webhooks")).body.webhooks, []);
    assert.equal((await api(node, auth, "DELETE", `${BASE}/bob/${bob.id}`)).status, 404, "a second delete finds nothing");
  } finally {
    if (child) await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});

async function messages(node: SeededNode, auth: SignedIn): Promise<BobMessage[]> {
  return (await api<Timeline>(node, auth, "GET", "/control-center/bob/messages")).body.messages;
}

async function say(node: SeededNode, auth: SignedIn, directory: string, text: string, intent: unknown): Promise<BobMessage> {
  await writeFile(path.join(directory, "intent.json"), typeof intent === "string" ? intent : JSON.stringify(intent));
  const reply = await api<{ reply: BobMessage }>(node, auth, "POST", "/control-center/bob/message", { message: text });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return reply.body.reply;
}

test("Bob lists, pauses and resumes at once, and asks before he changes, deletes or creates", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "control-automations-chat-"));
  let child: ChildProcess | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const project = node.projects[0];
    const directory = path.join(root, "stubs");
    await mkdir(directory, { recursive: true });
    child = await startNode(environment, node, directory);
    const auth = await signIn(environment, node);
    const list = async () => (await api<Listed>(node, auth, "GET", BASE)).body.rows;
    const task = (await api<{ task: CronTask }>(node, auth, "POST", `${BASE}/schedule`, { projectId: project.id, name: "Nightly release check", prompt: "Run the release gate", schedule: { frequency: "daily", time: "02:00", timezone: "UTC" } })).body.task;
    const report = (await api<{ schedule: { id: string } }>(node, auth, "POST", `${BASE}/bob`, { report: "morning", timezone: "UTC" })).body.schedule;
    const taskKey = `schedule:${task.id}`;
    const reportKey = `bob:${report.id}`;

    // Listing agrees with the table: the same rows, in the same words.
    const listing = await say(node, auth, directory, "what scheduled tasks do I have?", { intent: "list" });
    assert.match(listing.text, /^2 automations:/);
    assert.match(listing.text, /on · Morning report \(Bob report\) · All projects · Daily 08:00 · Bob's chat · never run/);
    assert.match(listing.text, new RegExp(`on · Nightly release check \\(scheduled task\\) · ${project.name} · Daily 02:00`));
    assert.equal(listing.via, "Automations · listed 2");

    // Pausing and resuming happen at once, because the person asked for exactly that.
    const paused = await say(node, auth, directory, "pause the nightly scheduled task and the morning report", { intent: "pause", targets: [taskKey, reportKey] });
    assert.match(paused.text, /Paused: "Nightly release check", "Morning report"\./);
    assert.deepEqual(paused.actions, []);
    assert.deepEqual((await list()).map((row) => row.enabled), [false, false]);
    assert.equal((await api<{ tasks: CronTask[] }>(node, auth, "GET", `/projects/${project.id}/cron`)).body.tasks[0].enabled, false, "the scheduled task screen agrees");
    const again = await say(node, auth, directory, "pause the scheduled task", { intent: "pause", targets: [taskKey] });
    assert.match(again.text, /Already paused: "Nightly release check"\./);
    const resumed = await say(node, auth, directory, "resume the scheduled task", { intent: "resume", targets: [taskKey] });
    assert.match(resumed.text, /Resumed: "Nightly release check"\./);
    assert.deepEqual((await list()).map((row) => row.enabled), [false, true]);
    const unknown = await say(node, auth, directory, "pause that schedule", { intent: "pause", targets: ["schedule:00000000-0000-0000-0000-000000000000"] });
    assert.match(unknown.text, /I could not find/);

    // Changing a name or a time waits for the button too, and keeps what was not mentioned.
    const retime = await say(node, auth, directory, "move the nightly scheduled task to 03:30 and call it Release gate", { intent: "change", target: taskKey, name: "Release gate", time: "03:30" });
    assert.equal(retime.importance, "needs-you");
    assert.match(retime.text, /Change "Nightly release check".*\nNew name: Release gate\nNew time: every day at 03:30 \(UTC\), instead of Daily 02:00/s);
    assert.equal((await list()).find((row) => row.kind === "schedule")!.when, "Daily 02:00", "nothing changed before the button");
    const changed = await api<{ messages: BobMessage[] }>(node, auth, "POST", "/control-center/bob/action", { messageId: retime.id, actionId: "automations.change" });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.match(changed.body.messages[0].text, /Changed "Nightly release check"/);
    const retimed = (await list()).find((row) => row.kind === "schedule")!;
    assert.deepEqual([retimed.name, retimed.when, retimed.enabled], ["Release gate", "Daily 03:30", true]);
    assert.equal((await api<{ tasks: CronTask[] }>(node, auth, "GET", `/projects/${project.id}/cron`)).body.tasks[0].prompt, "Run the release gate", "the instructions stay");
    const reportTime = await say(node, auth, directory, "send the morning report at 07:15", { intent: "change", target: reportKey, time: "07:15" });
    await api(node, auth, "POST", "/control-center/bob/action", { messageId: reportTime.id, actionId: "automations.change" });
    assert.match((await list()).find((row) => row.kind === "bob")!.when, /^Daily 07:15/);
    const weekly = await say(node, auth, directory, "make the morning report weekly", { intent: "change", target: reportKey, frequency: "weekly" });
    assert.match(weekly.text, /runs every day/);
    assert.deepEqual(weekly.actions, []);

    // Deleting waits for the button. Nothing is deleted by the message alone.
    const ask = await say(node, auth, directory, "delete the nightly scheduled task", { intent: "delete", targets: [taskKey] });
    assert.equal(ask.importance, "needs-you");
    assert.deepEqual(ask.actions.map((action) => [action.id, action.style ?? null]), [["automations.delete", "warn"], ["automations.cancel", null]]);
    assert.equal((await list()).length, 2);
    const pressed = await api<{ messages: BobMessage[] }>(node, auth, "POST", "/control-center/bob/action", { messageId: ask.id, actionId: "automations.delete" });
    assert.equal(pressed.status, 200, JSON.stringify(pressed.body));
    assert.match(pressed.body.messages[0].text, /Deleted "Release gate"\./);
    assert.deepEqual((await list()).map((row) => row.name), ["Morning report"]);
    assert.equal((await api<{ tasks: CronTask[] }>(node, auth, "GET", `/projects/${project.id}/cron`)).body.tasks.length, 0);
    assert.equal((await api(node, auth, "POST", "/control-center/bob/action", { messageId: ask.id, actionId: "automations.delete" })).status, 404, "a button runs once");

    // Cancelling changes nothing.
    const keep = await say(node, auth, directory, "delete the morning report", { intent: "delete", targets: [reportKey] });
    const cancelled = await api<{ messages: BobMessage[] }>(node, auth, "POST", "/control-center/bob/action", { messageId: keep.id, actionId: "automations.cancel" });
    assert.match(cancelled.body.messages[0].text, /nothing was changed/);
    assert.equal((await list()).length, 1);

    // Creating a scheduled task shows what will be made, and makes it only when the button is pressed.
    const createTask = await say(node, auth, directory, "add a scheduled task that checks the logs every day at 7am", { intent: "create", create: { kind: "schedule", projectId: project.id, name: "Log check", prompt: "Check the logs for errors", frequency: "daily", time: "07:00" } });
    assert.equal(createTask.importance, "needs-you");
    assert.match(createTask.text, /Create this scheduled task in .*every day at 07:00/);
    assert.equal((await list()).length, 1);
    await api(node, auth, "POST", "/control-center/bob/action", { messageId: createTask.id, actionId: "automations.create" });
    assert.deepEqual((await list()).map((row) => [row.kind, row.name, row.when]), [["bob", "Morning report", "Daily 07:15 · Bob's chat"], ["schedule", "Log check", "Daily 07:00"]]);

    const createReport = await say(node, auth, directory, "also send me an evening report at 7pm", { intent: "create", create: { kind: "report", report: "evening" } });
    assert.match(createReport.text, /Create the evening report\? .* every day at 19:00/);
    await api(node, auth, "POST", "/control-center/bob/action", { messageId: createReport.id, actionId: "automations.create" });
    assert.deepEqual((await list()).map((row) => row.name), ["Evening report", "Morning report", "Log check"]);

    // A webhook's address is shown once, so Bob sends the person to the form instead of putting it in the chat.
    const webhook = await say(node, auth, directory, "create a webhook for GitHub", { intent: "create", create: { kind: "webhook", name: "GitHub" } });
    assert.deepEqual(webhook.actions, []);
    assert.match(webhook.text, /shown only once/);
    assert.equal((await list()).length, 3);

    // Whatever the agent says is checked: a reply that is not an intent changes nothing.
    const confused = await say(node, auth, directory, "pause the schedule", "I think you want to pause something");
    assert.match(confused.text, /could not tell what you want done/);
    const invented = await say(node, auth, directory, "delete the scheduled task", { intent: "delete", targets: ["schedule:made-up"] });
    assert.match(invented.text, /could not find/);
    assert.deepEqual(invented.actions, []);
    assert.equal((await list()).length, 3);
    // Every reply is in Bob's timeline with its label.
    assert.ok((await messages(node, auth)).some((message) => message.importance === "needs-you" && message.via === "Automations · waiting for you"));
  } finally {
    if (child) await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});

test("Bob writes his reports on their time, skips them while paused, and never queues a missed one", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "control-automations-reports-"));
  let child: ChildProcess | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const project = node.projects[0];
    const directory = path.join(root, "stubs");
    await mkdir(directory, { recursive: true });
    child = await startNode(environment, node, directory);
    const auth = await signIn(environment, node);
    const row = async () => (await api<Listed>(node, auth, "GET", BASE)).body.rows[0];
    const reports = async () => (await messages(node, auth)).filter((message) => message.importance === "report");

    const created = await api<{ schedule: { id: string } }>(node, auth, "POST", `${BASE}/bob`, { report: "evening", timezone: "UTC" });
    const id = created.body.schedule.id;
    // The only thing that makes a report due is its stored time; moving it close is what the clock would do at 19:00.
    const due = async (inMilliseconds: number) => {
      const db = nodeDatabase(node);
      try { db.prepare("UPDATE control_center_bob_schedules SET next_run = ? WHERE id = ?").run(Date.now() + inMilliseconds, id); } finally { db.close(); }
      // Saving a schedule points the single timer at the earliest due time again.
      assert.equal((await api(node, auth, "PUT", `${BASE}/bob/${id}`, { enabled: true })).status, 200);
    };
    const nextRun = (): number => {
      const db = nodeDatabase(node);
      try { return (db.prepare("SELECT next_run FROM control_center_bob_schedules WHERE id = ?").get(id) as { next_run: number }).next_run; } finally { db.close(); }
    };

    // It runs when due, written by Bob's agent, and lands in the timeline as a report with its own label.
    await writeFile(path.join(directory, "report.txt"), "Two things waited for you today. Nothing failed.");
    await due(1500);
    const written = await until(async () => (await reports())[0], "the evening report");
    assert.equal(written.text, "Two things waited for you today. Nothing failed.");
    assert.match(written.via ?? "", /^Evening report · scheduled 19:00 · written by Bob's agent$/);
    assert.equal(written.projectId, null, "a report across projects is General");
    const afterRun = await row();
    assert.deepEqual([afterRun.last.state, afterRun.last.detail], ["ok", null]);
    // At its next 19:00, which is minutes away when this runs just before 19:00, and never due again at once.
    const next = new Date(nextRun());
    assert.ok(next.getTime() > Date.now() && next.getUTCHours() === 19 && next.getUTCMinutes() === 0, `the next report is at its next time, not queued: ${next.toISOString()}`);

    // When the agent cannot write it, the facts are posted and the note says why.
    await rm(path.join(directory, "report.txt"));
    await due(1000);
    const plain = await until(async () => (await reports())[1], "the report without the agent");
    assert.match(plain.text, /^Evening report for /);
    assert.match(plain.text, /Nothing ran, nothing failed and nothing is waiting for you\.$/);
    assert.match(plain.via ?? "", /facts only, Bob's agent could not write it/);

    // A finished conversation that waits for review is in the report, with a button that reads its summary.
    const audit = await api<{ task: CronTask }>(node, auth, "POST", "/cron", { nodeId: node.nodeId, command: { action: "create", input: {
      projectId: project.id, name: "Dependency audit", prompt: "Audit the dependencies", engine: "claude", sessionId: null, ownerNodeId: node.nodeId, enabled: true, markForReview: true,
      schedule: { frequency: "daily", hour: 4, minute: 0, weekday: 1, timezone: "UTC" },
    } } });
    assert.equal(audit.status, 200, JSON.stringify(audit.body));
    const makeTaskDue = (taskId: string) => {
      const db = nodeDatabase(node);
      try { db.prepare("UPDATE cron_tasks SET next_run = ? WHERE id = ?").run(Date.now(), taskId); } finally { db.close(); }
    };
    makeTaskDue(audit.body.task.id);
    const card = await until(async () => (await api<{ cards: Array<{ title: string; column: string }> }>(node, auth, "GET", "/control-center/board")).body.cards.find((candidate) => candidate.column === "review"), "the finished conversation on the board");
    await due(1000);
    const withReview = await until(async () => (await reports())[2], "the report with something waiting");
    assert.match(withReview.text, new RegExp(`Waiting for you \\(1\\):\\n- \\[${project.name}\\] ${card.title}`));
    assert.deepEqual(withReview.actions.map((action) => [action.id, action.label]), [["automations.item-1", `Summary: ${card.title}`]]);
    const summary = await api<{ messages: BobMessage[] }>(node, auth, "POST", "/control-center/bob/action", { messageId: withReview.id, actionId: "automations.item-1" });
    assert.equal(summary.status, 200, JSON.stringify(summary.body));
    assert.equal(summary.body.messages[0].text.split("\n")[0], card.title);
    assert.equal(summary.body.messages[0].projectName, project.name);

    // A failed scheduled run is in the report too, with a button to run that task again.
    const task = (await api<{ task: CronTask }>(node, auth, "POST", `${BASE}/schedule`, { projectId: project.id, name: "Slow query report", prompt: "Report slow queries", schedule: { frequency: "daily", time: "03:00", timezone: "UTC" } })).body.task;
    const db = nodeDatabase(node);
    try { db.prepare("INSERT INTO cron_runs (id, task_id, due_at, status, error, finished_at) VALUES (?, ?, ?, 'failed', ?, ?)").run(crypto.randomUUID(), task.id, Date.now() - 600_000, "Budget reached: daily limit", Date.now() - 590_000); } finally { db.close(); }
    await due(1000);
    const withFailure = await until(async () => (await reports())[3], "the report with a failed run");
    assert.match(withFailure.text, /Failed runs \(1\):\n- \[.*\] Slow query report \(scheduled task\): Budget reached: daily limit/);
    assert.deepEqual(withFailure.actions.map((action) => [action.id, action.label]), [["automations.item-1", `Summary: ${card.title}`], ["automations.item-2", "Run again: Slow query report"]]);
    const again = await api<{ messages: BobMessage[] }>(node, auth, "POST", "/control-center/bob/action", { messageId: withFailure.id, actionId: "automations.item-2" });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.match(again.body.messages[0].text, /Started "Slow query report" again/);
    assert.deepEqual(again.body.messages[0].actions.map((action) => action.id), ["automations.item-1"], "the other button comes along");

    // Paused: nothing is written, the report is marked skipped, and it is not kept for when Bob is back.
    await api(node, auth, "PUT", "/control-center/bob/settings", { monitoring: false });
    const before = (await reports()).length;
    await due(1000);
    const skipped = await until(async () => (await api<Listed>(node, auth, "GET", BASE)).body.rows.find((candidate) => candidate.kind === "bob" && candidate.last.state === "skipped"), "the skipped report");
    assert.match(skipped.last.detail ?? "", /Bob was paused/);
    assert.equal((await reports()).length, before);
    await api(node, auth, "PUT", "/control-center/bob/settings", { monitoring: true });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal((await reports()).length, before, "nothing was queued while Bob was paused");
    const resumed = new Date(nextRun());
    assert.ok(resumed.getTime() > Date.now() && resumed.getUTCHours() === 19 && resumed.getUTCMinutes() === 0, `back at its next time: ${resumed.toISOString()}`);

    // A report whose time passed while the server was off is missed, not written late.
    await due(-45 * 60_000);
    const missed = await until(async () => (await api<Listed>(node, auth, "GET", BASE)).body.rows.find((candidate) => candidate.kind === "bob" && /Missed at 19:00/.test(candidate.last.detail ?? "")), "the missed report");
    assert.equal(missed.last.state, "skipped");
    assert.equal((await reports()).length, before);

    // Send now writes one even while Bob is paused: the person asked for it.
    await api(node, auth, "PUT", "/control-center/bob/settings", { monitoring: false });
    const sent = await api<{ message: BobMessage }>(node, auth, "POST", `${BASE}/bob/${id}/send`, {});
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.message.importance, "report");
    assert.match(sent.body.message.via ?? "", /sent now/);
    assert.equal((await reports()).length, before + 1);
    assert.equal((await api(node, auth, "POST", `${BASE}/bob/not-there/send`, {})).status, 404);
  } finally {
    if (child) await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});
